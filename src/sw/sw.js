// filepath: src/sw/sw.js
// ---------------------------------------------------------------------------
// ORQUESTADOR DEL SERVICE WORKER
// Este es el único punto de entrada del SW. Mantiene la lógica de evento
// (`fetch`, `install`, `activate`) y delega el trabajo de traducción a
// módulos especializados. Cualquier secreto vive aquí gracias al flag
// `define` de vite.config.js, nunca en la rama del cliente.
// ---------------------------------------------------------------------------

import {
  FICTIONAL_DOMAIN,
  SUPABASE_GRAPHQL_ENDPOINT,
  GATEWAY_CORS_ORIGIN
} from '../config/constants.js';

import { handleRequest } from './router/requestRouter.js';

// --- Ciclo de vida ----------------------------------------------------------

self.addEventListener('install', () => {
  // Activa la nueva versión sin esperar a que las pestañas cierren.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Toma control inmediato de los clientes ya abiertos.
  event.waitUntil(self.clients.claim());
});

// --- Mensajes de diagnóstico (útiles desde DevTools) -----------------------

self.addEventListener('message', (event) => {
  if (event?.data === 'LUMO_PING') {
    event.source?.postMessage({
      type: 'LUMO_PONG',
      endpoint: SUPABASE_GRAPHQL_ENDPOINT
    });
  }
});

// --- Interceptación NATIVA de fetch ----------------------------------------

// --- CORS: cabeceras inyecadas en TODA respuesta del gateway ---------------
// Esto permite que páginas servidas desde otro origen (p.ej. el preview de
// Vite en localhost) consuman el gateway sin disparar errores de CORS.
// El dominio ficticio no existe en DNS, por lo que cualquier fetch
// cross-origin debe llevar estas cabeceras para que el body sea legible.
//
// `Access-Control-Allow-Origin` se inyecta desde la variable de entorno
// `GATEWAY_CORS_ORIGIN` (default `*` para dev local). Si en producción
// quieres restringirlo, define ese `.env` como el origen concreto de la
// app que consume el gateway.
const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin':  GATEWAY_CORS_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, Prefer, X-Client-Info',
  'Access-Control-Max-Age':       '600',
});

self.addEventListener('fetch', (event) => {
  // Solo nos interesa el dominio ficticio. El resto sigue su curso normal.
  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return; // Bypass.
  }

  if (url.hostname !== FICTIONAL_DOMAIN) {
    return; // Bypass: el navegador atenderá la petición de forma estándar.
  }

  // Preflight CORS: respondemos directamente sin pasar por el router
  // para que el navegador autorice la petición real subsiguiente.
  if (event.request.method === 'OPTIONS') {
    event.respondWith(new Response(null, { status: 204, headers: CORS_HEADERS }));
    return;
  }

  // `respondWith` permite entregar una Response arbitraria desde el SW.
  // Envolvemos la promesa para:
  //   1. Clonar las cabeceras e inyectar CORS sin alterar la lógica del
  //      router (que sigue creando sus propias Response).
  //   2. Garantizar que NINGUNA excepción escape al navegador como
  //      `NetworkError` opaco: cualquier crash (incluido un `AbortError`
  //      por cancelación del cliente) cae aquí y se transforma en una
  //      Response 500/499 con cuerpo JSON legible.
  event.respondWith(
    handleRequest(event.request, url)
      .then((response) => withCors(response))
      .catch((err) => withCors(errorToResponse(err, url)))
  );
});

/**
 * Clona una `Response` y le añade las cabeceras CORS del gateway.
 * Si la respuesta ya es opaca (network error) se devuelve tal cual.
 */
function withCors(response) {
  try {
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    return new Response(response.body, {
      status:     response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

/**
 * Construye una `Response` de error segura a partir de cualquier valor
 * lanzado. Se usa como última barrera antes de devolver al cliente para
 * evitar que un error inesperado (TypeError, AbortError, etc.) se
 * convierta en un `NetworkError` opaco que rompa la UX.
 *
 * @param {unknown} err
 * @param {URL}     url
 * @returns {Response}
 */
function errorToResponse(err, url) {
  // Si el cliente abortó la petición (AbortError), respondemos 499 para
  // que el observador del cliente pueda distinguir cancelación de fallo.
  const isAbort =
    err && typeof err === 'object' && (err.name === 'AbortError' || err.code === 20);
  const status = isAbort ? 499 : 500;
  const code   = isAbort ? 'CLIENT_CLOSED_REQUEST' : 'LUMO_INTERNAL';

  const body = JSON.stringify({
    error: `Lumo gateway error: ${err?.message || String(err)}`,
    code,
  });

  return new Response(body, {
    status,
    headers: {
      'Content-Type':   'application/json',
      'X-Lumo-Gateway': '1',
      'X-Lumo-Path':    url?.pathname ?? '',
      'X-Lumo-Source':  FICTIONAL_DOMAIN,
    },
  });
}
