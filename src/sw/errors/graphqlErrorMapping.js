// filepath: src/sw/errors/graphqlErrorMapping.js
// ---------------------------------------------------------------------------
// Mapeo de errores GraphQL (HTTP 200 + `errors[]` en el body) a status HTTP
// coherentes con la causa real.
//
// La spec de GraphQL devuelve 200 incluso con errores a nivel de aplicación
// (resolución, validación, permisos). Sin este mapeo, el cliente siempre
// vería HTTP 200 aunque la operación haya fallado, lo que obliga a
// inspeccionar el body en cada fetch. Este helper cierra esa brecha.
// ---------------------------------------------------------------------------

const NOT_FOUND_CODES = new Set([
  'NOT_FOUND',
  'RECORD_NOT_FOUND',
  'NO_ROWS_FOUND',
]);

const VALIDATION_CODES = new Set([
  'GRAPHQL_VALIDATION_FAILED',
  'BAD_USER_INPUT',
  'INVALID_INPUT',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
]);

/**
 * Dado el array `errors` de una respuesta GraphQL, devuelve el status HTTP
 * más coherente con la causa. Devuelve `null` si no hay errores.
 *
 * @param {Array} [errors]
 * @returns {number|null} 200, 400, 404, 500 o null.
 */
export function graphqlStatusFromErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return null;

  const codes = errors.map((e) => e?.extensions?.code).filter(Boolean);

  if (codes.some((c) => NOT_FOUND_CODES.has(c)))   return 404;
  if (codes.some((c) => VALIDATION_CODES.has(c))) return 400;

  // Errores GraphQL sin código reconocible → gateway error interno.
  return 500;
}