/**
 * Lain core — canonical JSON serialization.
 *
 * Integrity hashing must not depend on property insertion order, on whether a
 * producer ran on Windows or Linux, or on how a JSON parser happened to order
 * keys. `canonicalJson` therefore produces one deterministic byte sequence per
 * value:
 *
 *   - object keys sorted by UTF-16 code unit (`Array.prototype.sort` default)
 *   - no insignificant whitespace
 *   - `undefined`, functions and symbols are rejected rather than silently
 *     dropped, because silently dropping a field would change what was hashed
 *     without changing the hash's meaning to a caller
 *   - non-finite numbers are rejected (JSON.stringify would write `null`)
 *
 * This is not a general-purpose serializer: it exists so that
 * `sha256(canonicalJson(payload))` is reproducible.
 */

import { createHash } from 'node:crypto';
import { IntegrityError } from './errors.mjs';

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {string}
 */
function encode(value, path) {
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(/** @type {number} */ (value))) {
      throw new IntegrityError('NON_FINITE_NUMBER', `cannot canonicalize a non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'string') return JSON.stringify(value);

  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new IntegrityError(
      'UNSERIALIZABLE_VALUE',
      `cannot canonicalize a ${type} at ${path}: it would be silently dropped, changing the hashed content`,
      { path, type },
    );
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, i) => encode(item, `${path}[${i}]`)).join(',')}]`;
  }

  const record = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => {
    const item = record[key];
    if (item === undefined) {
      throw new IntegrityError(
        'UNSERIALIZABLE_VALUE',
        `cannot canonicalize an undefined property at ${path}.${key}`,
        { path: `${path}.${key}` },
      );
    }
    return `${JSON.stringify(key)}:${encode(item, `${path}.${key}`)}`;
  });
  return `{${parts.join(',')}}`;
}

/**
 * Deterministic JSON text for a JSON-representable value.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return encode(value, '$');
}

/**
 * sha256 of the canonical form, as lowercase hex.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalHash(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/**
 * sha256 of arbitrary bytes, as lowercase hex.
 *
 * @param {string | Uint8Array} data
 * @returns {string}
 */
export function hashBytes(data) {
  return createHash('sha256').update(data).digest('hex');
}
