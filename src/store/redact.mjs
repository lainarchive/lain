import { StoreError, RedactionError } from '../core/errors.mjs';
import { canonicalJson } from '../core/json.mjs';
import { requireRecord, requireString, typeName } from '../core/validate.mjs';

/**
 * Redaction happens before an event is persisted, never after.
 *
 * The event log is append-only: a secret written once is permanent, and no later
 * cleanup can be proven complete. So the rule is that a payload which cannot be
 * safely redacted is not written at all, and a payload that still looks like it
 * contains a known secret shape after redaction is refused rather than stored.
 *
 * This module deliberately knows nothing about policy or permissions. It decides
 * what may be stored, not who may act.
 */

/** Field names whose values must never be persisted verbatim. */
export const SENSITIVE_KEY_NAMES = Object.freeze([
  'password',
  'passwd',
  'secret',
  'client_secret',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'auth_token',
  'bearer',
  'authorization',
  'private_key',
  'credential',
  'credentials',
  'session_cookie',
  'set-cookie',
  'cookie',
]);

/** High-confidence value shapes. Kept conservative: a false positive loses a field, a false negative loses a secret forever. */
export const SECRET_VALUE_PATTERNS = Object.freeze([
  { name: 'private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws_access_key_id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'github_token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'slack_token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'stripe_key', re: /sk-(live|test)-[A-Za-z0-9]{10,}/ },
  { name: 'openai_style_key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'google_api_key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
]);

/** Prefix kept so an operator can see which field was redacted without recovering it. */
const MASK_PREFIX = '[redacted:';

/** @param {string} reason */
function mask(reason) {
  return `${MASK_PREFIX}${reason}]`;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isSensitiveKeyName(name) {
  const lower = name.toLowerCase();
  return SENSITIVE_KEY_NAMES.includes(lower);
}

/**
 * Redact a JSON value. Returns a new value; the input is never mutated, so a
 * caller holding the original cannot accidentally persist it afterwards.
 *
 * @param {unknown} value
 * @param {{path?: string, rules?: {key_name: number, value_pattern: number}, maxDepth?: number}} [opts]
 * @returns {unknown}
 */
export function redactValue(value, opts = {}) {
  const maxDepth = opts.maxDepth ?? 32;
  const rules = opts.rules ?? { key_name: 0, value_pattern: 0 };

  /**
   * @param {unknown} node
   * @param {number} depth
   * @param {string} path
   * @returns {unknown}
   */
  function walk(node, depth, path) {
    if (depth > maxDepth) {
      throw new RedactionError('REDACTION_DEPTH', `payload exceeds the redaction depth ceiling at ${path || '$'}`, { path: path || '$', maxDepth });
    }
    if (node === null) return null;
    if (typeof node === 'string') {
      let out = node;
      for (const { name, re } of SECRET_VALUE_PATTERNS) {
        if (re.test(out)) {
          rules.value_pattern += 1;
          out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), mask(name));
        }
      }
      return out;
    }
    if (typeof node === 'number' || typeof node === 'boolean') return node;
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, depth + 1, `${path}[${index}]`));
    }
    if (typeof node === 'object') {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [key, item] of Object.entries(/** @type {Record<string, unknown>} */ (node))) {
        const childPath = path === '' ? key : `${path}.${key}`;
        if (isSensitiveKeyName(key)) {
          rules.key_name += 1;
          out[key] = mask('sensitive-key');
          continue;
        }
        out[key] = walk(item, depth + 1, childPath);
      }
      return out;
    }
    // undefined, function, symbol and bigint are not JSON. canonicalJson refuses
    // them later; redaction passes them through unchanged so the failure is
    // reported by the serializer with its own precise message.
    return node;
  }

  return walk(value, 0, opts.path ?? '');
}

/**
 * Scan a serialized payload for anything that still matches a secret shape.
 * This is the fail-closed backstop: it runs on the exact bytes that would be
 * written, so redaction that missed a field for any reason cannot be persisted.
 *
 * @param {string} text
 * @returns {{name: string, at: number}[]}
 */
export function findResidualSecrets(text) {
  /** @type {{name: string, at: number}[]} */
  const hits = [];
  for (const { name, re } of SECRET_VALUE_PATTERNS) {
    const match = re.exec(text);
    if (match) hits.push({ name, at: match.index });
  }
  return hits;
}

/**
 * Prepare a payload for persistence: validate it is JSON, redact it, serialize it
 * canonically, and refuse the write if any secret shape survives.
 *
 * @param {unknown} payload
 * @returns {{text: string, redaction: {applied: boolean, rules: {key_name: number, value_pattern: number}}}}
 */
export function preparePayload(payload) {
  requireRecord({ payload }, 'event');
  const rules = { key_name: 0, value_pattern: 0 };
  const redacted = redactValue(payload, { rules });
  let text;
  try {
    text = canonicalJson(redacted);
  } catch (err) {
    throw new RedactionError('PAYLOAD_NOT_SERIALIZABLE', 'the payload could not be serialized canonically, so it was not stored', {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  const residual = findResidualSecrets(text);
  if (residual.length > 0) {
    throw new RedactionError('RESIDUAL_SECRET', 'the payload still matches a known secret shape after redaction; the write is refused', {
      patterns: residual.map((hit) => hit.name),
      payloadBytes: text.length,
    });
  }
  return {
    text,
    redaction: {
      applied: rules.key_name > 0 || rules.value_pattern > 0,
      rules,
    },
  };
}

/**
 * @param {string} value
 * @param {string} what
 * @returns {string}
 */
export function requireIdentifier(value, what) {
  return requireString(value, what, { min: 1, max: 200 });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function describeValue(value) {
  if (typeof value === 'string') return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return typeName(value);
}

export { StoreError };
