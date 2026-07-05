// filepath: src/sw/config/gatewayPolicy.js
// ---------------------------------------------------------------------------
// GATEWAY POLICY: configuración declarativa del comportamiento de fetch
// saliente hacia Supabase.
//
// Diseño:
//   - securityOverrides: SIEMPRE se imponen, ignorando el Request original.
//     Son decisiones de seguridad innegociables del gateway.
//   - behavioralOverrides: por defecto valen `undefined`, lo que provoca
//     que el router OMITA esa clave del init de `new Request(url, init)`.
//     Según la especificación de Fetch, omitir la clave hace que se
//     HEREDE del Request original. Esto preserva la intención del
//     navegador siempre que sea seguro.
//
// El router usa `buildOutboundInit(...)` para componer el init. Para
// CAMBIAR una opción heredable basta con asignarle un valor aquí; para
// relajar una opción de seguridad hay que ser explícito y consciente.
// ---------------------------------------------------------------------------

/**
 * Opciones que el SW FIJA por seguridad, sin importar lo que diga el
 * Request original. Modificarlas aquí rompe el aislamiento entre cliente
 * y backend real.
 */
const SECURITY_OVERRIDES = Object.freeze({
  // Nunca enviar cookies del cliente al backend de Supabase.
  credentials:    'omit',
  // Nunca exponer el referrer de la página (puede contener paths internos).
  referrerPolicy: 'no-referrer',
});

/**
 * Opciones que el gateway SOLO aplica si están definidas. Cuando valen
 * `undefined` se OMITE la clave del init para permitir la herencia del
 * Request original. Esto preserva `cache`, `redirect`, `keepalive` y
 * `mode` declarados por el navegador siempre que sea coherente.
 *
 * Ejemplos de override (descomentar la línea y asignar valor):
 *   cache:     'no-store',   // deshabilitar caché HTTP para GraphQL
 *   redirect:  'manual',     // no seguir 30x automáticamente
 *   keepalive: true,         // mantener conexión viva tras cerrar pestaña
 *   mode:      'same-origin',// forzar same-origin (raro; solo si Supabase está en el mismo origen)
 */
const BEHAVIORAL_OVERRIDES = Object.freeze({
  cache:     undefined,
  redirect:  undefined,
  keepalive: undefined,
  mode:      undefined,
});

/** Política pública, congelada para evitar mutaciones accidentales. */
export const GATEWAY_POLICY = Object.freeze({
  ...SECURITY_OVERRIDES,
  ...BEHAVIORAL_OVERRIDES,
});

/**
 * Compone el objeto `init` que se pasará a `fetch(SUPABASE_URL, init)`
 * preservando el máximo número posible de propiedades del Request
 * original.
 *
 * Reglas:
 *   - method, headers, body y signal se imponen SIEMPRE (la lógica del
 *     gateway lo requiere y `signal` no se hereda automáticamente).
 *   - Las claves en `GATEWAY_POLICY` con valor definido se imponen.
 *   - Las claves con valor `undefined` se OMITE del init, lo que hace
 *     que `fetch()` las herede del Request original.
 *
 * @param {object}  ctx
 * @param {Request} ctx.request  - Request original del navegador.
 * @param {Headers} ctx.headers  - Cabeceras mutadas (clon del original).
 * @param {BodyInit} ctx.body    - Body GraphQL serializado.
 * @param {string}  [ctx.method] - Método HTTP (default 'POST').
 * @returns {RequestInit}
 */
export function buildOutboundInit({ request, headers, body, method = 'POST' }) {
  const init = { method, headers, body, signal: request.signal };

  for (const [key, value] of Object.entries(GATEWAY_POLICY)) {
    if (value !== undefined) init[key] = value;
  }

  return init;
}

/** Acceso de solo-lectura a las overrides, útil para diagnóstico desde DevTools. */
export function describePolicy() {
  const security = Object.entries(SECURITY_OVERRIDES).map(([k, v]) => `${k}=${v}`);
  const behavioral = Object.entries(BEHAVIORAL_OVERRIDES)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  const inherited = Object.entries(BEHAVIORAL_OVERRIDES)
    .filter(([, v]) => v === undefined)
    .map(([k]) => k);

  return { security, behavioral, inherited };
}