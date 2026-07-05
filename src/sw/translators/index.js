// filepath: src/sw/translators/index.js
// ---------------------------------------------------------------------------
// REGISTRO AUTO-DESCUBIERTO de traductores.
//
// Contrato base (mínimo que el router necesita de cualquier traductor):
//   - `route`              string  → pathname REST ficticio, p.ej. '/orders'
//   - `engine`             string? → 'GRAPHQL' (default) o 'REST'
//   - `translateResponse`  fn      → (data, ctx) => payload aplanado
//
// Según el motor, el traductor debe exportar ADEMÁS:
//   - GRAPHQL: `translateRequest(params)` → string de query GraphQL
//   - REST:    `translateToRest(params, ctx)` → RestSpec (ver más abajo)
//
// El router los descubre automáticamente vía `import.meta.glob` (Vite)
// en tiempo de bundle — NO hace falta tocar este archivo al añadir
// endpoints. Si un archivo no exporta `route`, se ignora (útil para
// módulos helper, ejemplos o traductores aún en borrador).
//
// ---------------------------------------------------------------------------
// CONTRATO REST (RestSpec devuelto por `translateToRest`):
//
//   {
//     path:   string,            // Sufijo de path tras /rest/v1/  (p.ej. 'orders')
//     method: 'GET'|'POST'|'PATCH'|'DELETE',
//     query:  URLSearchParams,   // Filtros PostgREST (eq.X, gte.X, select=*, ...)
//     body?:  BodyInit,          // Opcional. Si se omite, NO se envía body.
//     prefer?:string             // Opcional. PostgREST 'Prefer' header.
//   }
//
// ---------------------------------------------------------------------------

const ENGINES = Object.freeze({ GRAPHQL: 'GRAPHQL', REST: 'REST' });

/**
 * Vite reemplaza `import.meta.glob` por un mapa estático `{ ruta: módulo }`
 * en el bundle final, por lo que el "descubrimiento" ocurre en build-time
 * sin overhead en runtime.
 */
const modules = import.meta.glob('./*.js', { eager: true });

/** @type {Record<string, {
 *   engine: 'GRAPHQL'|'REST',
 *   translateRequest?: Function,
 *   translateToRest?: Function,
 *   translateResponse: Function,
 * }>} */
const translators = Object.create(null);

for (const [, mod] of Object.entries(modules)) {
  if (!mod || typeof mod !== 'object') continue;
  if (typeof mod.route !== 'string') continue;
  if (typeof mod.translateResponse !== 'function') continue;

  // Motor: default GRAPHQL si el traductor no lo declara explícitamente.
  // Esto preserva la compatibilidad con traductores existentes (products, users).
  const engine = (typeof mod.engine === 'string' && mod.engine.toUpperCase() === 'REST')
    ? ENGINES.REST
    : ENGINES.GRAPHQL;

  // Validar que el traductor expone la función que le corresponde a su motor.
  if (engine === ENGINES.GRAPHQL && typeof mod.translateRequest !== 'function') continue;
  if (engine === ENGINES.REST      && typeof mod.translateToRest   !== 'function') continue;

  // Advertir colisiones: dos módulos no pueden declarar el mismo `route`.
  if (translators[mod.route]) {
    console.warn(`[Lumo] route duplicado "${mod.route}"; se conserva el primero.`);
    continue;
  }

  translators[mod.route] = {
    engine,
    translateRequest:  mod.translateRequest,  // definido solo en GRAPHQL
    translateToRest:   mod.translateToRest,   // definido solo en REST
    translateResponse: mod.translateResponse,
  };
}

/**
 * Devuelve el traductor registrado para el `pathname`.
 * @param {string} pathname
 * @returns {{
 *   engine: 'GRAPHQL'|'REST',
 *   translateRequest?: Function,
 *   translateToRest?: Function,
 *   translateResponse: Function,
 * } | null}
 */
export function getTranslator(pathname) {
  return translators[pathname] ?? null;
}

/** Lista pública de rutas disponibles (útil para introspección / debug). */
export const availableRoutes = Object.freeze(Object.keys(translators));