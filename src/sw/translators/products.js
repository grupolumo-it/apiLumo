// filepath: src/sw/translators/products.js
// ---------------------------------------------------------------------------
// Traductor:  /products
// Motor:      REST  (PostgREST sobre Supabase)
//
// Tabla principal:
//   - products
//
// Tablas relacionadas (FK `product_id` -> products.id):
//   - product_prices           precios por país / moneda
//   - attributes               atributos dinámicos (jsonb)
//   - products_categories      categorías del producto (1..N)
//
// ---------------------------------------------------------------------------
// ARQUITECTURA: PROYECCIÓN DE CAMPOS 100% DINÁMICA
//
// Por defecto, NINGUNA relación se proyecta ni se incluye en la
// respuesta. El frontend debe solicitar cada relación EXPLÍCITAMENTE
// mediante uno de los siguientes meta-parámetros:
//
//   prices      none | ALL | <country>[,<country>...]
//                            → product_prices(country,currency,price)
//                              + (filtro relacional si hay lista)
//   categories  none | ALL | <name>[,<name>...]
//                            → products_categories(category_name)
//                              + (filtro relacional si hay lista)
//   attributes  none | ALL | <type>[,<type>...]
//                            → attributes(type,content)
//                              + (filtro relacional si hay lista)
//
// Sintaxis universal por meta-parámetro:
//   ausente | vacío | "none"   → relación OMITIDA (no proyección, no JSON)
//   "ALL" | "all"              → relación PROYECTADA, sin filtro
//   "v1,v2,v3"                 → relación PROYECTADA + filtro relacional
//                                con lista por comas
//
// Otros query params aceptados (sobre campos atómicos, no relaciones):
//   limit     number   paginación tolerante, 1..100 (default 10)
//   id        string   eq/in sobre `products.id`                    (lista por comas)
//   search    string   ilike case-insensitive sobre `products.name` (siempre parcial)
//
// Params del cliente IGNORADOS: cualquier otro (la SW define su
// superficie, no el cliente).
//
// ---------------------------------------------------------------------------
// FORMATO REST generado:
//
//   GET /rest/v1/products?
//     select=id,name,description,image_url                 (siempre)
//     [, product_prices(country,currency,price)]           (si prices ≠ none)
//     [, products_categories(category_name)]               (si categories ≠ none)
//     [, attributes(type,content)]                         (si attributes ≠ none)
//     &limit=10
//     &id=eq.prod-12345              (o id=in.(p1,p2,p3))
//     &name=ilike.*watch*            (search)
//     [, product_prices.country=in.(US,MX)]                (si prices=US,MX)
//     [, products_categories.category_name=eq.calzado]      (si categories=calzado)
//     [, attributes.type=in.(peso,color)]                  (si attributes=peso,color)
//
// ---------------------------------------------------------------------------
// CONTRATO DE RESPUESTA ({ items: [...] }):
//
// Las propiedades `prices`, `categories` y `attributes` SOLO aparecen
// en el JSON final cuando el frontend las solicitó explícitamente:
//
//   - SOLICITADA con resultados → propiedad presente con array poblado
//   - SOLICITADA sin resultados → propiedad presente con []
//   - NO SOLICITADA            → PROPIEDAD AUSENTE (no se incluye [])
//
// Esta distinción es semánticamente importante: "no pediste" se ve
// diferente a "pediste y no hay nada".
// ---------------------------------------------------------------------------

/** @type {string} Pathname REST ficticio que atiende este traductor. */
export const route = '/products';

/** @type {'REST'} Motor del backend real al que se traduce. */
export const engine = 'REST';

// ---------------------------------------------------------------------------
// Constantes internas
// ---------------------------------------------------------------------------

/** Path principal: la tabla `products`. */
const PRODUCTS_PATH = 'products';

/** Método: GET (PostgREST prefiere GET para SELECT con filtros). */
const PRODUCTS_METHOD = 'GET';

/**
 * Proyección base (siempre presente). Solo campos atómicos del
 * producto. Las relaciones se concatenan CONDICIONALMENTE según los
 * meta-parámetros `prices`, `categories`, `attributes`.
 */
const SCALAR_FIELDS = 'id,name,description,image_url';

/** Bounds de paginación tolerante para `limit`. 0 es valor válido (0 resultados). */
const LIMIT_MIN     = 0;
const LIMIT_MAX     = 100;
const LIMIT_DEFAULT = 10;

// ---------------------------------------------------------------------------
// Catálogo declarativo de RELACIONES (proyección + filtro por meta-parámetro)
// ---------------------------------------------------------------------------

/**
 * Cada entrada mapea:
 *   - `key`  (implícito, el del objeto)
 *   - meta-parámetro del cliente (`prices` | `categories` | `attributes`)
 *   - `sentinels`  palabras mágicas que NO se interpretan como valores
 *   - `column`     columna relacional sobre la que se aplican filtros
 *                  (formato PostgREST `tabla.columna`)
 *   - `projection` string de resource embedding para el `select` de
 *                  PostgREST
 *
 * Añadir una cuarta relación futura es trivial: nueva entrada aquí.
 */
const RELATIONS = Object.freeze({
  prices: {
    sentinels:  { none: 'none', all: 'all' },
    column:     'product_prices.country',
    projection: 'product_prices(country,currency,price)',
  },
  categories: {
    sentinels:  { none: 'none', all: 'all' },
    column:     'products_categories.category_name',
    projection: 'products_categories(category_name)',
  },
  attributes: {
    sentinels:  { none: 'none', all: 'all' },
    column:     'attributes.type',
    projection: 'attributes(type,content)',
  },
});

/**
 * Catálogo de filtros sobre campos ESCALARES (no relaciones).
 * Las relaciones ya no se filtran por aquí — eso lo hace el catálogo
 * `RELATIONS` arriba, junto con la proyección.
 */
const FILTERS = Object.freeze({
  id:     { mode: 'eq_or_in', column: 'id'   },
  search: { mode: 'ilike',    column: 'name' },
});

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/**
 * Parsea y sanea el parámetro `limit` desde la URL.
 * Tolerante con entrada inválida: si el valor no es un número, cae al
 * default. Si está fuera del rango [1, 100], se CLAMPA al borde (no lanza).
 *
 * @param {string|null|undefined} raw
 * @returns {number}
 */
function parseLimit(raw) {
  if (raw === null || raw === undefined || raw === '') return LIMIT_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return LIMIT_DEFAULT;
  if (n < LIMIT_MIN) return LIMIT_MIN;
  if (n > LIMIT_MAX) return LIMIT_MAX;
  return n;
}

/**
 * Lee un string de los query params y lo devuelve saneado, o `null` si
 * está ausente / vacío (la ausencia es la señal de "no aplicar").
 *
 * @param {URLSearchParams|null|undefined} params
 * @param {string}                          key
 * @returns {string|null}
 */
function readString(params, key) {
  if (!params || typeof params.get !== 'function') return null;
  const raw = params.get(key);
  if (raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Parte un valor "raw" en sus tokens separados por coma, recorta
 * espacios y descarta entradas vacías.
 *
 *   "a,b,c"       → ["a", "b", "c"]
 *   "a, b ,c "    → ["a", "b", "c"]
 *   "a,"          → ["a"]
 *   ",,"          → []
 *
 * @param {string|null|undefined} raw
 * @returns {string[]}
 */
function splitMultiValue(raw) {
  if (raw === null || raw === undefined) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resuelve la estrategia de proyección/filtro para un meta-parámetro
 * de relación. Devuelve un plan inmutable que el traductor usará para:
 *   1. Decidir si concatenar la proyección al `select`.
 *   2. Decidir si añadir un filtro relacional `tabla.columna=eq|in.(...)`
 *      al query string.
 *
 * Reglas (case-insensitive, aplicadas tras trim + split por comas):
 *
 *   raw === null                          → { include: false, filterValues: [] }
 *   raw === sentinels.none (cualquier Cf) → { include: false, filterValues: [] }
 *   raw = "" (split vacío)                → { include: false, filterValues: [] }
 *   raw contiene sentinels.all en         → { include: true,  filterValues: [] }
 *     cualquier posición                    (ALL manda; el resto se ignora)
 *   raw = lista de tipos reales           → { include: true,  filterValues: [...] }
 *
 * @param {string|null|undefined} raw       Valor ya saneado por `readString`.
 * @param {{ none: string, all: string }} sentinels  Palabras mágicas del meta-param.
 * @returns {{ include: boolean, filterValues: string[] }}
 */
function resolveRelationStrategy(raw, sentinels) {
  if (raw === null) {
    return { include: false, filterValues: [] };
  }

  if (raw.toLowerCase() === sentinels.none) {
    return { include: false, filterValues: [] };
  }

  const values = splitMultiValue(raw);
  if (values.length === 0) {
    return { include: false, filterValues: [] };
  }

  // Si CUALQUIER token es el sentinel "all", manda ese modo y se
  // ignora el resto (lectura conservadora: "ALL" es keyword mágica).
  if (values.some((v) => v.toLowerCase() === sentinels.all)) {
    return { include: true, filterValues: [] };
  }

  return { include: true, filterValues: values };
}

/**
 * Aplica el patrón universal `eq_or_in` al `URLSearchParams`:
 *   - 0 valores  → no agrega nada.
 *   - 1 valor    → `<columna>=eq.<valor>`
 *   - N valores  → `<columna>=in.(<v1>,<v2>,...)`
 *
 * @param {URLSearchParams} query
 * @param {string}          column  Columna PostgREST (puede incluir
 *                                  prefijo `tabla.` para relaciones
 *                                  embebidas).
 * @param {string[]}        values  Lista de valores ya saneados.
 * @returns {void}
 */
function applyEqOrIn(query, column, values) {
  if (values.length === 0) return;
  if (values.length === 1) {
    query.set(column, `eq.${values[0]}`);
    return;
  }
  query.set(column, `in.(${values.join(',')})`);
}

/**
 * Aplica el patrón `ilike.*value*` (búsqueda parcial case-insensitive).
 *
 * @param {URLSearchParams} query
 * @param {string}          column  Columna a filtrar (ya saneada del catálogo).
 * @param {string}          value   Texto a buscar (ya trimmed).
 * @returns {void}
 */
function applyIlike(query, column, value) {
  query.set(column, `ilike.*${value}*`);
}

// ---------------------------------------------------------------------------
// API pública del traductor (consumida por el router)
// ---------------------------------------------------------------------------

/**
 * Construye la especificación REST para consultar `/products` con
 * PostgREST bajo la arquitectura 100% dinámica.
 *
 * Pipeline:
 *   1. Resolver la estrategia de CADA relación (proyección + filtro).
 *   2. Ensamblar `select` concatenando SOLO las relaciones que se
 *      incluyen (sobre los `SCALAR_FIELDS` siempre presentes).
 *   3. Aplicar filtros relacionales para las relaciones incluidas
 *      con lista de valores.
 *   4. Aplicar filtros escalares declarativos (`id`, `search`).
 *
 * @param {URLSearchParams} params  Params recibidos del cliente.
 * @returns {{
 *   path: string,
 *   method: 'GET',
 *   query: URLSearchParams
 * }} Especificación REST lista para el router.
 */
export function translateToRest(params) {
  const limit = parseLimit(params?.get?.('limit'));

  // -------------------------------------------------------------------------
  // 1. Estrategias por relación (proyección + filtro).
  // -------------------------------------------------------------------------
  const strategies = {};
  for (const [key, rel] of Object.entries(RELATIONS)) {
    const raw = readString(params, key);
    strategies[key] = {
      ...rel,
      strategy: resolveRelationStrategy(raw, rel.sentinels),
    };
  }

  // -------------------------------------------------------------------------
  // 2. `select` dinámico. Partimos de los escalares y añadimos SOLO
  //    las relaciones que la estrategia ha decidido incluir.
  // -------------------------------------------------------------------------
  const selectParts = [SCALAR_FIELDS];
  for (const s of Object.values(strategies)) {
    if (!s.strategy.include) continue;
    // INNER JOIN restrictivo: si hay valores de filtro, inyectamos `!inner`
    // justo antes del primer paréntesis para que PostgREST aplique el WHERE
    // también sobre la tabla raíz. Sin valores (caso `all`) conservamos la
    // proyección original para no alterar el LEFT JOIN implícito.
    if (s.strategy.filterValues.length > 0) {
      selectParts.push(s.projection.replace('(', '!inner('));
    } else {
      selectParts.push(s.projection);
    }
  }

  const query = new URLSearchParams();
  query.set('select', selectParts.join(','));
  query.set('limit',  String(limit));

  // -------------------------------------------------------------------------
  // 3. Filtros relacionales (uno por relación incluida con valores).
  // -------------------------------------------------------------------------
  for (const s of Object.values(strategies)) {
    if (s.strategy.include && s.strategy.filterValues.length > 0) {
      applyEqOrIn(query, s.column, s.strategy.filterValues);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Filtros sobre campos escalares (id, search).
  // -------------------------------------------------------------------------
  for (const [clientKey, cfg] of Object.entries(FILTERS)) {
    const raw = readString(params, clientKey);
    if (raw === null) continue;

    if (cfg.mode === 'ilike') {
      applyIlike(query, cfg.column, raw);
      continue;
    }

    // mode === 'eq_or_in' (universal, multi-valor por comas)
    const values = splitMultiValue(raw);
    if (values.length === 0) continue;
    applyEqOrIn(query, cfg.column, values);
  }

  return {
    path:   PRODUCTS_PATH,
    method: PRODUCTS_METHOD,
    query,
  };
}

/**
 * Aplana la respuesta cruda de PostgREST al contrato final:
 *
 *   {
 *     items: [
 *       {
 *         id, name, description, image_url,
 *         // Las SIGUIENTES solo aparecen si se solicitaron:
 *         prices?:     [{ country, currency, price }],
 *         categories?: ["Cat1", "Cat2"],
 *         attributes?: [{ type, content }]
 *       },
 *       ...
 *     ]
 *   }
 *
 * Reglas de la arquitectura 100% dinámica:
 *   - PostgREST NO devuelve la clave de una relación que no se pidió
 *     en `select` (esa es la señal fiable de "no solicitada").
 *   - Si la clave está AUSENTE o es `null` en el JSON crudo, el
 *     mapeador omite la propiedad en el objeto de salida. NO se añade
 *     `[]` ni `null` por defecto.
 *   - Si la clave EXISTE y es array (con o sin items), se mapea con
 *     el aplanador correspondiente y SE INCLUYE en el output (incluso
 *     si quedó `[]`, como señal de "solicitada y vacía").
 *
 * Tolerancia defensiva:
 *   - Acepta array plano, `{ data: [...] }`, `{ items: [...] }`.
 *   - Ante input mal formado, devuelve `{ items: [] }` (no lanza).
 *
 * @param {unknown} data  JSON crudo devuelto por PostgREST.
 * @returns {{ items: Array<object> }}
 */
export function translateResponse(data) {
  // Localiza el array de productos en cualquiera de las formas
  // habituales. PostgREST devuelve array plano; los otros paths son
  // tolerancia frente a wrappers / middlewares.
  let raw;
  if (Array.isArray(data)) {
    raw = data;
  } else if (
    data &&
    typeof data === 'object' &&
    Array.isArray(data.data)
  ) {
    raw = data.data;
  } else if (
    data &&
    typeof data === 'object' &&
    Array.isArray(data.items)
  ) {
    raw = data.items;
  } else {
    raw = [];
  }

  const items = raw
    .filter((node) => node !== null && typeof node === 'object')
    .map(flattenProduct);

  return { items };
}

// ---------------------------------------------------------------------------
// Helpers de flatten (dinámicos por relación)
// ---------------------------------------------------------------------------

/**
 * ¿Está presente la relación en el nodo crudo?
 *
 * El criterio "clave ausente o null → no solicitada" se basa en el
 * comportamiento real de PostgREST: cuando una relación no está en
 * `select`, su clave NI SIQUIERA aparece en el JSON. Cuando SÍ está
 * y la relación está vacía, PostgREST serializa `[]`. Tratamos
 * `null` como ausente por tolerancia defensiva (caso degenerado).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isRelationPresent(value) {
  return value !== undefined && value !== null;
}

/**
 * Aplana un nodo `Product` de PostgREST al contrato público. Las
 * relaciones se añaden al objeto de salida ÚNICAMENTE cuando están
 * presentes en el nodo crudo (es decir, cuando el frontend las
 * solicitó). Si están ausentes, su clave simplemente NO aparece en
 * el output.
 *
 * PostgREST serializa las relaciones embebidas como arrays planos
 * (sin envolver en `{ items: [...] }`).
 *
 * @param {object} node
 * @returns {object}  Producto aplanado con claves condicionales.
 */
function flattenProduct(node) {
  // Base: los 4 campos atómicos, siempre presentes.
  const out = {
    id:          node.id          ?? null,
    name:        node.name        ?? null,
    description: node.description ?? null,
    image_url:   node.image_url   ?? null,
  };

  // Relaciones: se añaden SOLO si el nodo crudo las trae. La
  // condición `isRelationPresent` distingue "no pediste" vs "pediste
  // y la respuesta fue []".
  if (isRelationPresent(node.product_prices)) {
    out.prices = flattenArray(node.product_prices, flattenPrice);
  }

  if (isRelationPresent(node.products_categories)) {
    out.categories = flattenCategories(node.products_categories);
  }

  if (isRelationPresent(node.attributes)) {
    out.attributes = flattenArray(node.attributes, flattenAttribute);
  }

  return out;
}

/**
 * Aplica `mapper` a cada elemento de una relación embebida (array
 * plano de PostgREST). Si la colección no es un array, devuelve `[]`
 * (defensa ante respuestas degeneradas de PostgREST).
 *
 * @template T
 * @param {Array|undefined|null} collection
 * @param {(raw: object) => T}    mapper
 * @returns {T[]}
 */
function flattenArray(collection, mapper) {
  if (!Array.isArray(collection)) return [];
  return collection
    .filter((item) => item !== null && typeof item === 'object')
    .map(mapper);
}

/**
 * Aplana `products_categories` a un array PLANO de nombres de
 * categoría. El cliente consume strings, no objetos. Filtra cadenas
 * vacías por si una fila viniera sin `category_name` válido.
 *
 * @param {Array|undefined|null} collection
 * @returns {string[]}
 */
function flattenCategories(collection) {
  if (!Array.isArray(collection)) return [];
  return collection
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => (typeof item.category_name === 'string' ? item.category_name : ''))
    .filter((name) => name !== '');
}

/** @param {object} node */
function flattenPrice(node) {
  return {
    country:  node.country  ?? null,
    currency: node.currency ?? null,
    price:    node.price    ?? null,
  };
}

/** @param {object} node */
function flattenAttribute(node) {
  return {
    type:    node.type    ?? null,
    content: node.content ?? null,
  };
}
