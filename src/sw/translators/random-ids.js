// filepath: src/sw/translators/random-ids.js
// ---------------------------------------------------------------------------
// Traductor:  /utils/random-ids
// Motor:      REST  (PostgREST RPC sobre Supabase)
//
// Endpoint upstream:
//   POST  /rest/v1/rpc/get_random_ids        (sin query string)
//
// Body JSON enviado al RPC (PostgREST espera los argumentos en el body,
// NO en la URL; si viajan en query string la función recibe NULL para
// los parámetros NOT NULL y Supabase responde 400):
//   {
//     p_table_name:    "<table>",
//     p_limit:         <int>,
//     p_return_column: "<column>",
//     // opcionales (solo si vienen ambos en el cliente):
//     p_filter_column: "<column>",
//     p_filter_value:  "<value>"
//   }
//
// RPC PostgreSQL: public.get_random_ids(
//   p_table_name     text,            -- tabla de la cual samplear
//   p_limit          int,             -- cantidad máxima de ids
//   p_return_column  text   DEFAULT 'id', -- columna a devolver (proyectada a text)
//   p_filter_column  text   DEFAULT NULL, -- columna de filtro (WHERE)
//   p_filter_value   text   DEFAULT NULL  -- valor de filtro (vinculado con USING)
// )
//   → RETURNS SETOF text  (PostgREST lo serializa como ["id1","id2",...])
//
// Query params aceptados en la URL ficticia:
//   table          string   Nombre de la tabla              (default 'products')
//   limit          string   Cantidad máxima de filas        (default '10')
//   return_column  string   Columna a devolver              (default 'id')
//   filter_column  string   Columna de filtro (opcional; requiere filter_value)
//   filter_value   string   Valor de filtro  (opcional; requiere filter_column)
//
// Contrato de salida (lo que recibe el cliente):
//   { values: ["slug-1", "slug-2", ...] }   // cualquier string que devuelva el RPC
//
// Solo se reenvían los argumentos que el RPC acepta; cualquier otro
// param que venga del cliente se IGNORA silenciosamente (la SW define su
// superficie, no el cliente).
//
// Notas de seguridad:
//   - `table`, `return_column` y `filter_column` se inyectan en la SQL
//     vía format(... %I ...)  → se sanitizan como identificadores.
//   - `filter_value` viaja como parámetro vinculado (USING $2) → no
//     necesita la misma sanitización, solo se recorta y se valida
//     presencia.
//   - Si el cliente envía `filter_column` sin `filter_value` (o al
//     revés), ambos se OMITE para no enviar un WHERE incompleto.
// ---------------------------------------------------------------------------

/** @type {string} Pathname REST ficticio que atiende este traductor. */
export const route = '/utils/random-ids';

/** @type {'REST'} Motor del backend real al que se traduce. */
export const engine = 'REST';

// ---------------------------------------------------------------------------
// Constantes internas
// ---------------------------------------------------------------------------

/** Valores por defecto para los parámetros que el cliente puede omitir. */
const TABLE_DEFAULT         = 'products';
const LIMIT_DEFAULT         = '10';
const RETURN_COLUMN_DEFAULT = 'id';

/** Path del RPC expuesto por PostgREST (sufijo tras `/rest/v1/`). */
const RPC_PATH = 'rpc/get_random_ids';

/** Método HTTP esperado por PostgREST para invocar un RPC. */
const RPC_METHOD = 'POST';

/** Nombres exactos de los argumentos que la función PostgreSQL espera. */
const ARG_TABLE         = 'p_table_name';
const ARG_LIMIT         = 'p_limit';
const ARG_RETURN_COLUMN = 'p_return_column';
const ARG_FILTER_COLUMN = 'p_filter_column';
const ARG_FILTER_VALUE  = 'p_filter_value';

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/**
 * Lee un parámetro desde `URLSearchParams` con un valor por defecto.
 * Tolera `params` ausente / no-iterable: nunca lanza, devuelve el default.
 *
 * @param {URLSearchParams|null|undefined} params
 * @param {string}                          key
 * @param {string}                          fallback
 * @returns {string}
 */
function readParam(params, key, fallback) {
  if (!params || typeof params.get !== 'function') return fallback;
  const raw = params.get(key);
  if (raw === null || raw === undefined) return fallback;
  const trimmed = String(raw).trim();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Lee un parámetro opcional desde `URLSearchParams` y devuelve el valor
 * saneado o `null` si está ausente / vacío. La ausencia es la señal de
 * "no aplicar este argumento opcional".
 *
 * @param {URLSearchParams|null|undefined} params
 * @param {string}                          key
 * @returns {string|null}
 */
function readOptionalParam(params, key) {
  if (!params || typeof params.get !== 'function') return null;
  const raw = params.get(key);
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Parsea el parámetro `limit` como entero para enviarlo en el body JSON
 * (PostgREST requiere `int` para `p_limit`, no un string). Si el valor
 * no es numérico, cae al default. Mantiene el contrato "no lanza"
 * característico del traductor: una entrada inválida nunca rompe el
 * request, simplemente se sustituye por el default.
 *
 * @param {string|null|undefined} raw  Valor crudo (ya trimmed por `readParam`).
 * @returns {number}
 */
function parseLimit(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return Number.parseInt(LIMIT_DEFAULT, 10);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) {
    return Number.parseInt(LIMIT_DEFAULT, 10);
  }
  return n;
}

/**
 * Sanitiza un identificador SQL (nombre de tabla o columna): solo
 * permite caracteres válidos para un identificador "seguro" (letras,
 * dígitos, guión bajo). Cualquier otra cosa se considera inválida y se
 * devuelve el `fallback` provisto. Esto evita inyecciones vía los
 * parámetros `table`, `return_column` y `filter_column`, que PostgREST
 * formatea con `%I` y empotra directamente en la SQL dinámica.
 *
 * Regla: identificador SQL estándar → `[A-Za-z_][A-Za-z0-9_]*`
 *
 * @param {unknown} raw
 * @param {string}  fallback  Valor a devolver si `raw` no es válido.
 * @returns {string}
 */
function sanitizeIdentifier(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return fallback;
  return trimmed;
}

// ---------------------------------------------------------------------------
// API pública del traductor (consumida por el router)
// ---------------------------------------------------------------------------

/**
 * Construye la especificación REST para invocar el RPC
 * `get_random_ids(p_table_name, p_limit, p_return_column, p_filter_column,
 * p_filter_value)` en PostgREST.
 *
 * Mapea los params del cliente a los argumentos exactos que espera la
 * función PostgreSQL:
 *
 *   table          → p_table_name     (default 'products',   sanitizado)
 *   limit          → p_limit          (default '10',         saneado)
 *   return_column  → p_return_column  (default 'id',         sanitizado)
 *   filter_column  → p_filter_column  (opcional,             sanitizado)
 *   filter_value   → p_filter_value   (opcional)
 *
 * El par `filter_column`/`filter_value` se envía COMPLETO o NO se envía:
 * la función RPC solo añade el WHERE cuando ambos son no-nulos, así que
 * enviar uno solo sería ruido inútil.
 *
 * @param {URLSearchParams} params  Params recibidos del cliente.
 * @returns {{
 *   path: string,
 *   method: 'POST',
 *   query: URLSearchParams,
 *   body: string
 * }} Especificación REST lista para el router. `body` es el JSON
 *   serializado con los argumentos del RPC (PostgREST los lee del body,
 *   no de la URL). `query` se devuelve vacío para que el router no
 *   concatene nada en la URL.
 */
export function translateToRest(params) {
  const table         = sanitizeIdentifier(readParam(params, 'table',         TABLE_DEFAULT),         TABLE_DEFAULT);
  const limit         = parseLimit(readParam(params, 'limit', LIMIT_DEFAULT));
  const return_column = sanitizeIdentifier(readParam(params, 'return_column', RETURN_COLUMN_DEFAULT), RETURN_COLUMN_DEFAULT);

  // Par de filtro: deben estar ambos presentes y ambos válidos.
  // `filter_column` requiere sanitización porque va vía %I; `filter_value`
  // viaja como parámetro vinculado (USING $2), basta con que esté presente.
  const raw_filter_column = readOptionalParam(params, 'filter_column');
  const raw_filter_value  = readOptionalParam(params, 'filter_value');

  const filter_column = sanitizeIdentifier(raw_filter_column, null);
  const filter_value  = (filter_column !== null) ? raw_filter_value : null;

  // PostgREST RPC recibe los argumentos en el BODY JSON, no en la URL.
  // Si viajaran en query string la función recibiría NULL para
  // p_table_name (NOT NULL) y Supabase respondería 400. `p_limit` va
  // como número (el parámetro PG es `int`, no text).
  const body = {
    [ARG_TABLE]:         table,
    [ARG_LIMIT]:         limit,
    [ARG_RETURN_COLUMN]: return_column,
  };

  if (filter_column !== null && filter_value !== null) {
    body[ARG_FILTER_COLUMN] = filter_column;
    body[ARG_FILTER_VALUE]  = filter_value;
  }

  return {
    path:   RPC_PATH,
    method: RPC_METHOD,
    query:  new URLSearchParams(),   // vacío: nada en la URL
    body:   JSON.stringify(body),
  };
}

/**
 * Aplana la respuesta cruda del RPC al contrato que el cliente espera:
 *
 *   { values: ["v1", "v2", ...] }
 *
 * Los valores pueden ser de cualquier tipo text/serializable: ids,
 * slugs, emails, enums, etc. (depende de `return_column`). El RPC
 * devuelve `SETOF text`; PostgREST lo serializa como array plano de
 * strings. Reglas:
 *   - Acepta que `data` sea ya el array plano (`["v1", ...]`), que sea
 *     un wrapper `{ values: [...] }` o un payload envuelto por
 *     PostgREST (`{ data: [...] }`).
 *   - Programación defensiva: si el resultado no es un Array, devuelve
 *     `[]` en lugar de lanzar (mantiene al cliente vivo ante respuestas
 *     malformadas).
 *   - Cada valor se normaliza a string y se descarta cualquier nulo /
 *     `undefined` que el RPC pudiera colar.
 *
 * @param {unknown} data  JSON crudo devuelto por el RPC.
 * @returns {{ values: string[] }}
 */
export function translateResponse(data) {
  // Localiza el array de valores soportando tres formas habituales:
  //   1. data es directamente el array (lo más común en PostgREST RPC)
  //   2. data es { values: [...] } (algunos wrappers / clients)
  //   3. data es { data: [...] }    (algunos middlewares)
  let raw;
  if (Array.isArray(data)) {
    raw = data;
  } else if (
    data &&
    typeof data === 'object' &&
    Array.isArray(data.values)
  ) {
    raw = data.values;
  } else if (
    data &&
    typeof data === 'object' &&
    Array.isArray(data.data)
  ) {
    raw = data.data;
  } else {
    raw = [];
  }

  const values = raw
    .filter((v) => v !== null && v !== undefined)
    .map((v) => String(v));

  return { values };
}
