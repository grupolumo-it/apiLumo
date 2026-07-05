// filepath: src/client/lumo-api.js
// ---------------------------------------------------------------------------
// CASCARÓN PÚBLICO de API Lumo.
// Este archivo es el ÚNICO entregable que las páginas HTML deben incluir.
// Su responsabilidad es exclusiva:
//   1) Exponer `window.LumoApi` con helpers de registro del SW.
//   2) NO contener URLs de Supabase, llaves ni lógica de endpoints.
//
// Se carga desde el HTML con:
//   <script type="module" src="./dist/lumo-api.js"></script>
// ---------------------------------------------------------------------------

const VERSION = '1.0.0';
const DEFAULT_SW_URL = './sw.js';
const DEFAULT_SCOPE  = '/';
const FICTIONAL_GATEWAY = 'https://api.lumocolombia.com.co';

/**
 * Deriva el scope por defecto a partir de la URL del SW: su directorio
 * contenedor. Esto evita el `SecurityError` típico cuando el SW vive en
 * `/dist/sw.js` y el llamador intenta registrarlo con scope `/`: el
 * navegador limita el scope máximo al directorio del script, por lo que
 * basta con auto-detectarlo para que el SDK funcione tanto si la app se
 * sirve desde `/` (p.ej. `vite preview`) como desde un sub-path
 * (p.ej. Live Server exponiendo `/dist/`).
 *
 * @param {string} swUrl
 * @returns {string}
 */
function deriveScope(swUrl) {
  try {
    const u = new URL(swUrl, (typeof window !== 'undefined' && window.location?.href) || 'http://localhost/');
    const lastSlash = u.pathname.lastIndexOf('/');
    return lastSlash >= 0 ? u.pathname.substring(0, lastSlash + 1) : DEFAULT_SCOPE;
  } catch {
    return DEFAULT_SCOPE;
  }
}

/**
 * Registra el Service Worker de Lumo.
 *
 * @param {string} [swUrl='./sw.js']  - URL absoluta o relativa al script del SW.
 * @param {object} [opts]            - Opciones adicionales que se pasan a
 *                                     `navigator.serviceWorker.register()`.
 *                                     Si NO se pasa `opts.scope`, el SDK
 *                                     usa el directorio del SW (vía
 *                                     `deriveScope`) para evitar
 *                                     SecurityError por scope excesivo.
 * @returns {Promise<ServiceWorkerRegistration|null>}
 */
async function register(swUrl = DEFAULT_SW_URL, opts = {}) {
  if (!('serviceWorker' in navigator)) {
    console.warn(`[LumoApi v${VERSION}] Service Workers no soportados.`);
    return null;
  }

  // Resolver scope con prioridad: opts.scope > derivado del swUrl > DEFAULT.
  const finalScope = (opts.scope !== undefined && opts.scope !== null)
    ? opts.scope
    : deriveScope(swUrl);

  try {
    const registration = await navigator.serviceWorker.register(swUrl, {
      // Sin `type: 'module'`: Vite ya entrega `sw.js` como un script
      // empaquetado sin `import` top-level, así que funciona como SW
      // clásico universal (Chromium, Firefox, Safari mobile, WebViews).
      ...opts,
      scope: finalScope,
    });

    const state =
      registration.installing ? 'instalando' :
      registration.waiting    ? 'en espera'  :
      registration.active     ? 'activo'     : 'desconocido';

    console.log(`[LumoApi v${VERSION}] SW (${state}) registrado desde ${swUrl} (scope: ${finalScope}).`);
    return registration;
  } catch (err) {
    console.error(`[LumoApi v${VERSION}] Error registrando el SW:`, err);
    return null;
  }
}

/**
 * Espera a que el Service Worker controle la página actual.
 * @returns {Promise<ServiceWorkerRegistration|null>}
 */
async function ready() {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.ready;
}

/** API pública inmutable expuesta como `window.LumoApi`. */
const LumoApi = Object.freeze({
  version: VERSION,
  gateway: FICTIONAL_GATEWAY,
  register,
  ready,
});

// Exposición global — consumible desde cualquier <script>.
if (typeof window !== 'undefined') {
  window.LumoApi = LumoApi;
}

export default LumoApi;
export { register, ready, VERSION, FICTIONAL_GATEWAY };
