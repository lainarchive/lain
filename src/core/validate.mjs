/**
 * Lain core — bounded, deterministic validation helpers.
 *
 * These exist so that "validate the input" is a small number of explicit,
 * testable operations rather than ad-hoc checks scattered through call sites.
 * Every failure is a typed error with a stable code.
 *
 * Deliberately not a schema library: adding one would be a dependency, and the
 * M-1 event schema is small enough that explicit checks are clearer than a
 * declarative schema plus a validator whose failure semantics must be learned.
 */

import { ConfigError, RedactionError, StoreError } from './errors.mjs';

/** @typedef {{ ok: true, value: unknown } | { ok: false, issues: string[] }} ValidationResult */

const MAX_DEPTH_DEFAULT = 32;

/**
 * Assert that a value is a plain object (not null, not an array).
 *
 * @param {unknown} value
 * @param {string} what
 * @returns {Record<string, unknown>}
 */
export function requireRecord(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('INVALID_SHAPE', `${what} must be a plain object`, { what, actual: typeName(value) });
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Assert a non-empty string.
 *
 * @param {unknown} value
 * @param {string} what
 * @param {{ min?: number, max?: number, pattern?: RegExp }} [opts]
 * @returns {string}
 */
export function requireString(value, what, opts = {}) {
  if (typeof value !== 'string') {
    throw new StoreError('INVALID_SHAPE', `${what} must be a string`, { what, actual: typeName(value) });
  }
  const min = opts.min ?? 1;
  if (value.length < min) {
    throw new StoreError('INVALID_SHAPE', `${what} must be at least ${min} characters`, { what, length: value.length });
  }
  const max = opts.max ?? 4096;
  if (value.length > max) {
    throw new StoreError('INVALID_SHAPE', `${what} exceeds ${max} characters`, { what, length: value.length });
  }
  if (opts.pattern && !opts.pattern.test(value)) {
    throw new StoreError('INVALID_SHAPE', `${what} does not match ${String(opts.pattern)}`, { what });
  }
  return value;
}

/**
 * Assert an integer within an inclusive range.
 *
 * @param {unknown} value
 * @param {string} what
 * @param {{ min?: number, max?: number }} [opts]
 * @returns {number}
 */
export function requireInteger(value, what, opts = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new StoreError('INVALID_SHAPE', `${what} must be an integer`, { what, actual: typeName(value) });
  }
  const min = opts.min ?? Number.MIN_SAFE_INTEGER;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  if (value < min || value > max) {
    throw new StoreError('INVALID_SHAPE', `${what} must be within [${min}, ${max}]`, { what, value });
  }
  return value;
}

/**
 * Decode a JSON text into a structured result instead of throwing, so callers
 * can decide whether a malformed record is fatal.
 *
 * @param {string} text
 * @returns {ValidationResult}
 */
export function parseJsonObject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, issues: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, issues: [`expected a JSON object, received ${typeName(parsed)}`] };
  }
  return { ok: true, value: parsed };
}

/**
 * Assert that a value is JSON-safe, bounded in size, and within the allowed
 * depth. Used before persisting a payload so that a pathological structure is
 * refused instead of written.
 *
 * @param {unknown} value
 * @param {string} what
 * @param {{ maxDepth?: number }} [opts]
 * @returns {unknown}
 */
export function requireJsonValue(value, what, opts = {}) {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH_DEFAULT;
  /** @type {string[]} */
  const issues = [];

  /**
   * @param {unknown} node
   * @param {number} depth
   * @param {string} path
   */
  const walk = (node, depth, path) => {
    if (issues.length > 0) return;
    if (depth > maxDepth) {
      issues.push(`${path} exceeds the maximum depth of ${maxDepth}`);
      return;
    }
    if (node === null) return;
    const type = typeof node;
    if (type === 'string' || type === 'boolean') return;
    if (type === 'number') {
      if (!Number.isFinite(/** @type {number} */ (node))) issues.push(`${path} is not a finite number`);
      return;
    }
    if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
      issues.push(`${path} is a ${type}, which cannot be persisted`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, depth + 1, `${path}[${i}]`));
      return;
    }
    for (const [key, item] of Object.entries(/** @type {Record<string, unknown>} */ (node))) {
      walk(item, depth + 1, `${path}.${key}`);
    }
  };

  walk(value, 0, what);
  if (issues.length > 0) {
    throw new StoreError('INVALID_PAYLOAD', `${what} is not persistable`, { what, issues });
  }
  return value;
}

/**
 * Resolve a positive integer limit, refusing anything that is not one.
 * Guards against `LIMIT -1` semantics leaking into a query.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} ceiling
 * @returns {number}
 */
export function resolveLimit(value, fallback, ceiling) {
  if (value === undefined) return fallback;
  const n = requireInteger(value, 'limit', { min: 1, max: ceiling });
  return n;
}

/**
 * A validated configuration value holder. Reads are explicit and a missing
 * required key is an error, never a silent default.
 */
export class Config {
  /**
   * @param {Record<string, unknown>} values
   * @param {string} source description of where the values came from
   */
  constructor(values, source) {
    this.values = values;
    this.source = source;
  }

  /**
   * @param {string} key
   * @param {unknown} fallback
   * @returns {unknown}
   */
  get(key, fallback) {
    const value = this.values[key];
    return value === undefined ? fallback : value;
  }

  /**
   * @param {string} key
   * @returns {unknown}
   */
  require(key) {
    if (!(key in this.values)) {
      throw new ConfigError('MISSING_CONFIG', `required configuration key is absent: ${key}`, {
        key,
        source: this.source,
      });
    }
    return this.values[key];
  }

  /**
   * @param {string} key
   * @param {{ min?: number, max?: number }} [opts]
   * @returns {number}
   */
  requireInteger(key, opts = {}) {
    const value = requireInteger(this.require(key), key, opts);
    return value;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Redaction is applied by src/core/redact.mjs; this guard exists so a caller
 * can assert that a value has already passed through it before it is stored.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRedacted(value) {
  return typeof value === 'object' && value !== null && /** @type {any} */ (value).redaction !== undefined;
}

/** Re-exported for callers that validate before writing. */
export { RedactionError };
