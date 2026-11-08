/**
 * Lain core — identifier generation.
 *
 * Two requirements drive this module:
 *
 * 1. Identifiers must sort by creation time (ULID: 48-bit millisecond timestamp
 *    + 80 bits of randomness, Crockford base32). Ordering by id and ordering by
 *    time are then the same thing, which the event store relies on.
 * 2. Identifiers must be generated without a dependency.
 *
 * Randomness comes from `node:crypto`. A monotonic increment is applied inside
 * the same millisecond so that two ids created in one millisecond still sort in
 * creation order — IDs must never go backwards.
 */

import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I L O U
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

/** @type {number} */
let lastTime = -1;
/** @type {number[]} */
let lastRandom = new Array(RANDOM_CHARS).fill(0);

/**
 * Encode a non-negative integer into exactly `length` Crockford base32 chars.
 *
 * @param {number} value
 * @param {number} length
 * @returns {string}
 */
function encode(value, length) {
  let remaining = value;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out = ENCODING[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/**
 * @param {number} length
 * @returns {number[]}
 */
function randomChars(length) {
  const bytes = randomBytes(length);
  /** @type {number[]} */
  const out = [];
  for (const b of bytes) out.push(b % 32);
  return out;
}

/**
 * Generate a ULID.
 *
 * The timestamp argument is a *floor*, not an override: the returned id is
 * never older than the last id this process generated. That is what stops a
 * clock correction from handing out ids that sort before existing ones, and it
 * is why `ulidTime(ulid(t)) >= t` rather than `=== t` once any id has been
 * created later than `t`.
 *
 * @param {number} [now] timestamp in milliseconds; a lower bound
 * @returns {string} 26 characters, lexicographically time-ordered
 */
export function ulid(now = Date.now()) {
  const time = Math.max(now, lastTime);
  let random;
  if (time === lastTime) {
    // same millisecond: increment the previous randomness to preserve order
    random = [...lastRandom];
    let i = RANDOM_CHARS - 1;
    while (i >= 0) {
      const current = /** @type {number} */ (random[i]);
      if (current < 31) {
        random[i] = current + 1;
        break;
      }
      random[i] = 0;
      i -= 1;
    }
    if (i < 0) random = randomChars(RANDOM_CHARS); // exhausted: reseed
  } else {
    random = randomChars(RANDOM_CHARS);
  }
  lastTime = time;
  lastRandom = random;
  return encode(time, TIME_CHARS) + random.map((n) => ENCODING[n]).join('');
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUlid(value) {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

/**
 * Extract the embedded creation time.
 *
 * @param {string} id
 * @returns {number} milliseconds since epoch
 */
export function ulidTime(id) {
  if (!isUlid(id)) throw new TypeError(`not a ULID: ${String(id)}`);
  let time = 0;
  for (const ch of id.slice(0, TIME_CHARS)) time = time * 32 + ENCODING.indexOf(ch);
  return time;
}

/**
 * Reset the monotonic latch.
 *
 * Two legitimate callers: a test that needs deterministic ids, and a process
 * recovering after a *detected* clock regression. In the second case the caller
 * must record the regression as an event — the latch exists so that ids never go
 * backwards, not so that a broken clock passes unnoticed.
 */
export function resetUlidState() {
  lastTime = -1;
  lastRandom = new Array(RANDOM_CHARS).fill(0);
}

/**
 * A short, human-scannable correlation id for one logical operation.
 * Distinct from a ULID only in intent, not in form.
 *
 * @returns {string}
 */
export function correlationId() {
  return ulid();
}
