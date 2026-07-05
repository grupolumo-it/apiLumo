// filepath: src/config/constants.js
// ---------------------------------------------------------------------------
// Constantes inyectadas a nivel de AST por Vite (`define` en vite.config.js).
// Los identificadores con doble guion bajo son sustituidos por strings
// literales SOLO dentro del bundle dist/sw.js, gracias a que el cliente
// (src/client/lumo-api.js) jamás importa este módulo.
// ---------------------------------------------------------------------------

export const SUPABASE_URL              = __SUPABASE_URL__;
export const SUPABASE_ANON_KEY        = __SUPABASE_ANON_KEY__;
export const FICTIONAL_DOMAIN         = __FICTIONAL_DOMAIN__;
export const SUPABASE_GRAPHQL_ENDPOINT = __SUPABASE_GRAPHQL_ENDPOINT__;
// Endpoint PostgREST: derivado del mismo SUPABASE_URL vía sustitución AST,
// sin necesidad de tocar vite.config.js ni .env.
export const SUPABASE_REST_ENDPOINT   = `${__SUPABASE_URL__}/rest/v1`;
