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
  SUPABASE_GRAPHQL_ENDPOINT
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
const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin':  '*',
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
  // Envolvemos la promesa para clonar las cabeceras e inyectar CORS sin
  // alterar la lógica del router (que sigue creando sus propias Response).
  const inner = handleRequest(event.request, url);
  event.respondWith(
    inner.then((response) => withCors(response))
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
