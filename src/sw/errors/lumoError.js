// filepath: src/sw/errors/lumoError.js
// ---------------------------------------------------------------------------
// JERARQUÍA de errores del gateway.
//
// Cada subclase lleva consigo el status HTTP que el cliente debe recibir,
// de modo que el router no tenga que mantener un `switch` paralelo a las
// clases. Esto evita el antipatrón "todos los errores terminan en 500".
//
// Uso desde un traductor:
//   import { ValidationError } from '../errors/lumoError.js';
//   throw new ValidationError(`products: id inválido "${raw}"`);
// ---------------------------------------------------------------------------

export class LumoError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.status=500]   Status HTTP sugerido.
   * @param {string} [opts.code='LUMO_ERROR']  Código corto legible por máquina.
   * @param {Error}  [opts.cause]        Causa original (encadenamiento).
   */
  constructor(message, { status = 500, code = 'LUMO_ERROR', cause } = {}) {
    super(message);
    this.name    = this.constructor.name;
    this.status  = status;
    this.code    = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Entrada inválida: params REST malformados, número fuera de rango, etc. */
export class ValidationError extends LumoError {
  constructor(message, opts = {}) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', ...opts });
  }
}

/** Recurso inexistente: ruta sin traductor o registro no encontrado upstream. */
export class NotFoundError extends LumoError {
  constructor(message, opts = {}) {
    super(message, { status: 404, code: 'NOT_FOUND', ...opts });
  }
}

/** Upstream (Supabase) devolvió algo que el gateway no puede procesar. */
export class GatewayUpstreamError extends LumoError {
  constructor(message, opts = {}) {
    super(message, { status: 502, code: 'BAD_GATEWAY', ...opts });
  }
}