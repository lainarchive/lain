/**
 * Lain core — explicit, typed error hierarchy.
 *
 * Policy (M-1 brief §8): errors are never swallowed and never widened into a
 * generic `Error`. Every failure a caller might branch on has a stable `code`,
 * and every failure carries a `detail` object that is safe to record in the
 * event log (no secrets: see src/core/redact.mjs).
 */

/**
 * The minimum shape every Lain error exposes. Declared as a JSDoc typedef so
 * `tsc --checkJs` can verify call sites without the project shipping any .d.ts.
 *
 * @typedef {object} LainErrorShape
 * @property {string} code      stable machine-readable identifier, `SCREAMING_SNAKE`
 * @property {string} message   human-readable, no secrets
 * @property {Record<string, unknown>} detail safe-to-record context
 */

/**
 * Base class for every error Lain raises deliberately.
 *
 * Errors that are *not* subclasses of this (a TypeError from a bug, a failed
 * `require`) are, by definition, defects rather than expected failures: callers
 * should let them escape rather than translate them.
 */
export class LainError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.detail = detail;
  }

  /** @returns {LainErrorShape} */
  toRecord() {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

/** Configuration is absent, malformed, or contradicts itself. */
export class ConfigError extends LainError {}

/** A measurement required for a decision is missing or unusable. */
export class MeasurementError extends LainError {}

/**
 * A resource request cannot be admitted, or cannot be decided.
 *
 * `outcome` is deliberately explicit: `deny` means the request is refused;
 * `indeterminate` means a required measurement is unknown, so the request is
 * refused *and* the reason is recorded as unknown rather than as a limit.
 * Callers must never treat `indeterminate` as `allow`.
 */
export class AdmissionError extends LainError {
  /**
   * @param {'deny'|'indeterminate'} outcome
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [detail]
   */
  constructor(outcome, code, message, detail = {}) {
    super(code, message, detail);
    this.outcome = outcome;
  }
}

/** The event store refused an operation; the store state is unchanged. */
export class StoreError extends LainError {}

/** Another process holds the store's writer role. */
export class StoreLockedError extends StoreError {}

/** A stored byte sequence does not match its recorded integrity value. */
export class IntegrityError extends StoreError {}

/** Redaction could not be completed, so the write was refused. */
export class RedactionError extends LainError {}

/**
 * Narrow an unknown catch binding to a LainErrorShape without lying about it.
 *
 * @param {unknown} err
 * @returns {LainErrorShape}
 */
export function describeError(err) {
  if (err instanceof LainError) return err.toRecord();
  if (err instanceof Error) return { code: 'UNEXPECTED_ERROR', message: err.message, detail: { name: err.name } };
  return { code: 'UNEXPECTED_THROW', message: String(err), detail: {} };
}
