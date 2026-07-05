// filepath: src/sw/router/requestRouter.js
// ---------------------------------------------------------------------------
// ROUTER del Service Worker.
//
// Convierte cada `Request` interceptada (REST contra el dominio ficticio)
// en una consulta hacia Supabase, seleccionando el motor según el
// traductor registrado:
//
//   - GRAPHQL: POST a /graphql/v1 con body { query } (flujo original).
//   - REST:    GET/POST/PATCH/DELETE a /rest/v1/{path}?{query} (PostgREST).
//
// Ambos motores COMPARTEN:
//   - Cabeceras saneadas (host/origin/referer/cookie eliminadas)
//   - Autenticación (apikey + Authorization)
//   - Políticas de seguridad del gateway
//   - translateResponse(data, ctx)
//   - Manejo de errores y mapeo de status codes
//
// Política de status codes (cliente recibe códigos coherentes):
//   200/2xx            → datos aplanados del traductor
//   400                → ValidationError (input REST inválido)
//   404                → NotFoundError (sin traductor / recurso inexistente)
//   4xx/5xx Supabase   → preserva el status original del upstream
//   502                → upstream devolvió JSON inválido
//   500                → error inesperado del gateway
// ---------------------------------------------------------------------------

import { getTranslator } from '../translators/index.js';
import {
  SUPABASE_GRAPHQL_ENDPOINT,
  SUPABASE_REST_ENDPOINT,
  SUPABASE_ANON_KEY,
  FICTIONAL_DOMAIN
} from '../../config/constants.js';

import { buildOutboundInit } from '../config/gatewayPolicy.js';
import {
  LumoError,
  NotFoundError,
  GatewayUpstreamError
} from '../errors/lumoError.js';
import { graphqlStatusFromErrors } from '../errors/graphqlErrorMapping.js';

/**
 * Maneja una petición interceptada por el SW.
 *
 * Estrategia: componer el `init` de `fetch()` de forma que el constructor
 * interno del SW herede automáticamente del Request original cualquier
 * opción que la política no fuerce explícitamente (ver
 * `config/gatewayPolicy.js`).
 *
 * @param {Request} request - Request original que llegó al navegador.
 * @param {URL}    url      - URL parseada (ya validada contra FICTIONAL_DOMAIN).
 * @returns {Promise<Response>}
 */
export async function handleRequest(request, url) {
  try {
    const params = new URLSearchParams(url.search);

    // 1) Resolución del traductor. Sin traductor → 404 (no 500).
    const translator = getTranslator(url.pathname);
    if (!translator) {
      throw new NotFoundError(
        `Lumo: no hay traductor para "${url.pathname}"`,
        { code: 'TRANSLATOR_NOT_FOUND' }
      );
    }

    // 2) Cabeceras hacia Supabase: HEREDAR del cliente y MUTAR de forma
    //    declarativa. `new Headers(original)` crea un clon independiente.
    const outboundHeaders = buildOutboundHeaders(request);

    // 3) Bifurcación por motor. Comparten init/headers/autenticación.
    let upstreamUrl;
    let outboundInit;

    if (translator.engine === 'REST') {
      ({ upstreamUrl, outboundInit } = await buildRestOutbound({
        translator, params, request, url, headers: outboundHeaders,
      }));
    } else {
      ({ upstreamUrl, outboundInit } = buildGraphqlOutbound({
        translator, params, request, url, headers: outboundHeaders,
      }));
    }

    // 4) Ejecutar la consulta contra el upstream (Supabase).
    const upstreamResponse = await fetch(upstreamUrl, outboundInit);

    // 5) Si el upstream devuelve status no-2xx, preservar el código.
    if (!upstreamResponse.ok) {
      return passthroughUpstreamError(upstreamResponse, url, translator.engine);
    }

    // 6) Parsear JSON del upstream. Si corrupto → 502 (Bad Gateway).
    //    Soporta respuestas vacías (201/204 sin cuerpo) devolviendo {}.
    let rawJson;
    try {
      const text = await upstreamResponse.text();
      rawJson = text ? JSON.parse(text) : {};
    } catch (parseErr) {
      throw new GatewayUpstreamError(
        `Lumo: upstream devolvió JSON inválido (${parseErr?.message || parseErr})`,
        { cause: parseErr }
      );
    }

    // 7) Solo GraphQL: si trae `errors[]` con HTTP 200, mapear a status
    //    coherente (404/400/500). PostgREST no usa este concepto.
    if (translator.engine === 'GRAPHQL') {
      const gqlStatus = graphqlStatusFromErrors(rawJson?.errors);
      if (gqlStatus !== null) {
        return graphqlErrorResponse(rawJson, gqlStatus, url);
      }
    }

    // 8) Aplanar respuesta vía traductor (compartido por ambos motores).
    let cleanData;
    try {
      cleanData = translator.translateResponse(rawJson, {
        request, url, engine: translator.engine,
      });
    } catch (err) {
      throw new LumoError(
        `Lumo: traductor "${url.pathname}" falló aplanando respuesta`,
        { status: 500, code: 'TRANSLATOR_RESPONSE_FAILED', cause: err }
      );
    }

    return new Response(JSON.stringify(cleanData), {
      status:      upstreamResponse.status,
      statusText:  upstreamResponse.statusText,
      headers: {
        'Content-Type':   upstreamResponse.headers.get('Content-Type') || 'application/json',
        'X-Lumo-Gateway': '1',
        'X-Lumo-Path':    url.pathname,
        'X-Lumo-Source':  FICTIONAL_DOMAIN,
        'X-Lumo-Engine':  translator.engine,
      },
    });
  } catch (err) {
    return errorToResponse(err, url);
  }
}

// ---------------------------------------------------------------------------
// Helpers compartidos (cabeceras + auth)
// ---------------------------------------------------------------------------

/**
 * Construye las cabeceras salientes saneadas e inyecta autenticación.
 * Compartido por AMBOS motores.
 *
 * Política de auth contra Supabase:
 *   - `apikey` SIEMPRE se envía (es el identificador del proyecto; lo
 *     exige PostgREST y pg_graphql en cada request).
 *   - `Authorization` SOLO se reenvía si el cliente lo proveyó (con un
 *     JWT de usuario real). NO inyectamos `Bearer <anon_key>` porque:
 *       · Las anon keys antiguas (`eyJ...`) sí eran JWTs válidos.
 *       · Las nuevas (`sb_publishable_...`, formato 2024+) ya NO son
 *         JWTs: PostgREST las rechaza con 401 al intentar decodificarlas.
 *     La auth anónima queda implícita con solo `apikey`, suficiente para
 *     lecturas públicas y para que las policies RLS evalúen `anon`.
 */
function buildOutboundHeaders(request) {
  const headers = new Headers(request.headers);

  // Eliminar cabeceras de origen que NO deben cruzar al backend real.
  headers.delete('host');
  headers.delete('origin');
  headers.delete('referer');
  headers.delete('cookie'); // defensa adicional a credentials:'omit'

  // Obligatorias para Supabase (pg_graphql y PostgREST).
  headers.set('Content-Type', 'application/json');
  headers.set('apikey', SUPABASE_ANON_KEY);

  // Authorization: solo si el cliente lo proveyó (es un JWT de usuario).
  // Nunca inventamos uno a partir de la anon key.
  const clientAuth = request.headers.get('Authorization');
  if (clientAuth && clientAuth.trim() !== '') {
    headers.set('Authorization', clientAuth);
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Motores: GRAPHQL y REST
// ---------------------------------------------------------------------------

/**
 * Construye la petición saliente para el motor GRAPHQL (flujo original).
 * @returns {{ upstreamUrl: string, outboundInit: RequestInit }}
 */
function buildGraphqlOutbound({ translator, params, request, url, headers }) {
  let query;
  try {
    query = translator.translateRequest(params);
  } catch (err) {
    if (err instanceof LumoError) throw err;
    throw new LumoError(
      `Lumo: traductor "${url.pathname}" no pudo generar la query`,
      { status: 500, code: 'TRANSLATOR_FAILED', cause: err }
    );
  }
  if (!query) {
    throw new LumoError(
      `Lumo: traductor "${url.pathname}" devolvió query vacía`,
      { status: 500, code: 'TRANSLATOR_EMPTY' }
    );
  }

  return {
    upstreamUrl: SUPABASE_GRAPHQL_ENDPOINT,
    outboundInit: buildOutboundInit({
      request,                     // propaga signal (AbortController)
      headers,
      body: JSON.stringify({ query }),
    }),
  };
}

/**
 * Construye la petición saliente para el motor REST (PostgREST).
 * El traductor aporta path, método, query params y opcionalmente body/prefer.
 * @returns {Promise<{ upstreamUrl: string, outboundInit: RequestInit }>}
 */
async function buildRestOutbound({ translator, params, request, url, headers }) {
  const ctx = { request, url, params };
  let spec;
  try {
    // translateToRest puede ser async (p.ej. si necesita leer request body).
    spec = await translator.translateToRest(params, ctx);
  } catch (err) {
    if (err instanceof LumoError) throw err;
    throw new LumoError(
      `Lumo: translateToRest de "${url.pathname}" falló`,
      { status: 500, code: 'TRANSLATOR_REST_FAILED', cause: err }
    );
  }

  if (!spec || typeof spec.path !== 'string' || typeof spec.method !== 'string') {
    throw new LumoError(
      `Lumo: translateToRest de "${url.pathname}" devolvió spec inválido`,
      { status: 500, code: 'TRANSLATOR_REST_INVALID' }
    );
  }

  // path: quitar slashes de los extremos para concatenar limpiamente.
  const cleanPath  = spec.path.replace(/^\/+/, '').replace(/\/+$/, '');
  const queryString = (spec.query instanceof URLSearchParams)
    ? spec.query.toString()
    : (spec.query ? new URLSearchParams(spec.query).toString() : '');
  const upstreamUrl = `${SUPABASE_REST_ENDPOINT}/${cleanPath}${queryString ? `?${queryString}` : ''}`;

  // Prefer opcional (PostgREST).
  if (typeof spec.prefer === 'string' && spec.prefer.length > 0) {
    headers.set('Prefer', spec.prefer);
  }

  // Body: si el traductor lo omite (undefined), NO se envía.
  // Si lo aporta (string/Blob/FormData/...), se reenvía tal cual.
  // NOTA: necesitamos un objeto con la forma de Request (solo `signal`).
  const outboundInit = buildOutboundInit({
    request: { signal: request.signal },
    headers,
    method: spec.method,
    body: spec.body,   // undefined → no se envía body
  });

  return { upstreamUrl, outboundInit };
}

// ---------------------------------------------------------------------------
// Construcción de Responses de error
// ---------------------------------------------------------------------------

/** Response cuando el upstream devuelve un status no-2xx. */
function passthroughUpstreamError(upstreamResponse, url, engine) {
  return new Response(
    JSON.stringify({
      error:             `Lumo: upstream Supabase respondió ${upstreamResponse.status}`,
      engine,
      upstreamStatus:     upstreamResponse.status,
      upstreamStatusText: upstreamResponse.statusText,
    }),
    {
      status:      upstreamResponse.status,        // ← preserva el código original
      statusText:  upstreamResponse.statusText,
      headers: {
        'Content-Type':  'application/json',
        'X-Lumo-Gateway': '1',
        'X-Lumo-Path':    url.pathname,
        'X-Lumo-Source':  FICTIONAL_DOMAIN,
        'X-Lumo-Engine':  engine,
      },
    }
  );
}

/** Response cuando GraphQL devuelve `errors[]` con HTTP 200. */
function graphqlErrorResponse(rawJson, status, url) {
  return new Response(
    JSON.stringify({
      error:         'Lumo: GraphQL devolvió errores',
      graphqlErrors: rawJson.errors ?? [],
      data:          rawJson.data ?? null,
    }),
    {
      status,
      headers: {
        'Content-Type':  'application/json',
        'X-Lumo-Gateway': '1',
        'X-Lumo-Path':    url.pathname,
        'X-Lumo-Source':  FICTIONAL_DOMAIN,
        'X-Lumo-Engine':  'GRAPHQL',
      },
    }
  );
}

/** Mapea cualquier error capturado a una Response con status coherente. */
function errorToResponse(err, url) {
  if (err instanceof LumoError) {
    return new Response(
      JSON.stringify({ error: err.message, code: err.code }),
      {
        status: err.status,
        headers: baseHeaders(url),
      }
    );
  }

  return new Response(
    JSON.stringify({
      error: `Lumo gateway error: ${err?.message || err}`,
      code:  'LUMO_INTERNAL',
    }),
    {
      status: 500,
      headers: baseHeaders(url),
    }
  );
}

function baseHeaders(url) {
  return {
    'Content-Type':   'application/json',
    'X-Lumo-Gateway': '1',
    'X-Lumo-Path':    url?.pathname ?? '',
    'X-Lumo-Source':  FICTIONAL_DOMAIN,
  };
}