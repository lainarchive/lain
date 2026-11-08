// Approvals.
//
// An approval is a record, not a conversation. The failure this module exists to
// prevent is an agent that reads "the user did not say no" as "the user said
// yes".
//
// A window that closes with no answer is `timed_out`, which the policy turns into
// `deny_indeterminate`: not retryable, because the intent was never learned. An
// explicit `denied` is also a refusal, but a retryable one — circumstances
// change, and asking again after a change is not the same as ignoring the answer.
//
// A decision is bound to the exact request it approved, digest and all: a
// different tool, target or effect class is a different question, and a stale
// grant is refused rather than reused.
//
// An answer says where it came from. `human:<name>` is a person answering the
// question in front of them, `flag:<source>` is a flag that granted without one,
// `timeout` is nobody. A flag is not a human, and a ledger that cannot tell them
// apart cannot be audited.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from '../core/json.mjs';
import { ulid } from '../core/ids.mjs';
import { StoreError } from '../core/errors.mjs';
import { requireString } from '../core/validate.mjs';

/** @typedef {'pending'|'granted'|'denied'|'timed_out'} ApprovalStatus */

/** @typedef {'prompt'|'flag'} DecisionSource */

/**
 * @typedef {object} ApprovalRequest
 * @property {string} action
 * @property {string|null} [tool_id]
 * @property {string|null} [target]
 * @property {string} effect_class
 * @property {string|null} [task_id]
 */

/**
 * @typedef {object} ApprovalRecord
 * @property {string} approval_id
 * @property {string} binding        sha256 of the request: the request digest
 * @property {ApprovalStatus} status
 * @property {string} requested_at
 * @property {string} expires_at
 * @property {string|null} decided_at
 * @property {string|null} decided_by
 * @property {DecisionSource|'timeout'|null} decided_source  where the answer came from, so the file explains itself
 * @property {boolean} digest_verified  whether the answer carried this digest
 * @property {number} window_ms
 * @property {ApprovalRequest} request
 */

export const DEFAULT_APPROVAL_WINDOW_MS = 60_000;

/**
 * The `decided_by` of a window that closed with no answer. The policy's A2 arm
 * reads this state and returns `deny_indeterminate`, which is never retryable.
 * "Wait forever" is not a supported answer.
 */
export const TIMEOUT_DECIDED_BY = 'timeout';

export const HUMAN_DECIDED_BY_PREFIX = 'human:';

/** A flag granted without a person. Never mistake this for an answer. */
export const FLAG_DECIDED_BY_PREFIX = 'flag:';

/**
 * @param {string} name
 * @returns {string} the `decided_by` of a human answer
 */
export function decidedByHuman(name) {
  return `${HUMAN_DECIDED_BY_PREFIX}${requireString(name, 'by')}`;
}

/**
 * @param {string} [source] what granted it — a flag name, or `cli`
 * @returns {string} the `decided_by` of a flag-shaped approval
 */
export function decidedByFlag(source = 'cli') {
  return `${FLAG_DECIDED_BY_PREFIX}${source}`;
}

/**
 * Classify a `decided_by` value. A reader that needs to know whether a person
 * answered asks this rather than parsing the string itself.
 *
 * @param {string|null|undefined} decidedBy
 * @returns {'prompt'|'flag'|'timeout'|null}
 */
export function decisionSource(decidedBy) {
  if (decidedBy === TIMEOUT_DECIDED_BY) return 'timeout';
  if (typeof decidedBy === 'string' && decidedBy.startsWith(HUMAN_DECIDED_BY_PREFIX)) return 'prompt';
  if (typeof decidedBy === 'string' && decidedBy.startsWith(FLAG_DECIDED_BY_PREFIX)) return 'flag';
  return null;
}

/**
 * The identity of the question being asked. Two requests with the same binding
 * are the same question; anything else is a different one.
 *
 * @param {ApprovalRequest} request
 * @returns {string} hex sha256
 */
export function approvalBinding(request) {
  return createHash('sha256')
    .update(
      canonicalJson({
        action: request.action,
        tool_id: request.tool_id ?? null,
        target: request.target ?? null,
        effect_class: request.effect_class,
        task_id: request.task_id ?? null,
      }),
    )
    .digest('hex');
}

/**
 * The digest a person would read off the prompt and type back. Same value as the
 * binding; named separately because that is how the question reaches a human.
 *
 * @param {ApprovalRequest} request
 * @returns {string}
 */
export function approvalDigest(request) {
  return approvalBinding(request);
}

/**
 * Milliseconds left in the window; negative once it has closed.
 *
 * @param {{expires_at: string}} record
 * @param {number} [at]
 * @returns {number}
 */
export function approvalMsRemaining(record, at = Date.now()) {
  return Date.parse(record.expires_at) - at;
}

/**
 * @param {unknown} value
 * @returns {value is ApprovalRecord}
 */
function isApprovalRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  const row = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof row.approval_id === 'string' &&
    typeof row.binding === 'string' &&
    typeof row.status === 'string' &&
    typeof row.expires_at === 'string' &&
    typeof row.request === 'object' &&
    row.request !== null
  );
}

/** @param {string} digest */
function shortDigest(digest) {
  return digest.slice(0, 12);
}

/**
 * An in-memory ledger with an optional durable backing file.
 *
 * The default is memory because the first milestone has no long-running process
 * to survive. Passing `path` makes it durable, which is what lets one process ask
 * and another answer — deliberate, because an approval that vanishes on restart
 * is a security property and not a detail.
 *
 * @param {{
 *   now?: () => number,
 *   persist?: (record: object) => void|Promise<void>,
 *   path?: string|null,
 * }} [options]
 */
export function createApprovalLedger(options = {}) {
  const now = options.now ?? Date.now;
  const path = options.path ?? null;
  /** @type {Map<string, ApprovalRecord>} */
  const records = new Map();

  /**
   * Read the durable ledger, if there is one.
   *
   * A plain JSON parse would check neither that the row is shaped like an
   * approval nor that the question it displays hashes to the digest it claims. A
   * record whose target disagrees with its own binding is a question nobody can
   * answer honestly, so it is refused at load rather than shown as answerable.
   */
  function load() {
    if (!path || !existsSync(path)) return;
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new StoreError('APPROVAL_STORE_CORRUPT', `approval store ${path} is not readable JSON: ${detail}`);
    }
    const container = /** @type {{approvals?: unknown}} */ (parsed);
    const rows = Array.isArray(parsed) ? parsed : container?.approvals;
    if (!Array.isArray(rows)) {
      throw new StoreError('APPROVAL_STORE_CORRUPT', `approval store ${path} has no approvals array`);
    }
    for (const row of rows) {
      if (!isApprovalRecord(row)) {
        throw new StoreError('APPROVAL_STORE_CORRUPT', `approval store ${path} has a row that is not an approval record`);
      }
      if (approvalBinding(row.request) !== row.binding) {
        throw new StoreError(
          'APPROVAL_STORE_TAMPERED',
          `approval ${row.approval_id} shows a question that does not match its digest`,
        );
      }
      records.set(row.approval_id, row);
    }
  }

  /**
   * Write the whole ledger to the durable file, by rename so that a reader never
   * observes a half-written one.
   */
  function save() {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const partial = `${path}.partial`;
    writeFileSync(partial, `${JSON.stringify({ version: 1, approvals: [...records.values()] }, null, 2)}\n`, 'utf8');
    renameSync(partial, path);
  }

  /** @param {ApprovalRecord} record */
  function persistRecord(record) {
    save();
    void options.persist?.(record);
  }

  function expire() {
    const at = now();
    let changed = false;
    for (const record of records.values()) {
      if (record.status === 'pending' && Date.parse(record.expires_at) <= at) {
        record.status = 'timed_out';
        record.decided_at = new Date(at).toISOString();
        record.decided_by = TIMEOUT_DECIDED_BY;
        record.decided_source = 'timeout';
        changed = true;
      }
    }
    if (changed) save();
  }

  load();

  return {
    /**
     * Ask. Returns the existing pending approval for the same question if there
     * is one, so a retry cannot create a second prompt for the same decision.
     *
     * @param {ApprovalRequest} request
     * @param {{window_ms?: number}} [opts]
     * @returns {ApprovalRecord}
     */
    request(request, opts = {}) {
      expire();
      const binding = approvalBinding(request);
      for (const record of records.values()) {
        if (record.binding === binding && record.status === 'pending') return { ...record };
      }
      const windowMs = Number.isFinite(opts.window_ms) ? Number(opts.window_ms) : DEFAULT_APPROVAL_WINDOW_MS;
      /** @type {ApprovalRecord} */
      const record = {
        approval_id: ulid(now()),
        binding,
        status: 'pending',
        requested_at: new Date(now()).toISOString(),
        expires_at: new Date(now() + windowMs).toISOString(),
        decided_at: null,
        decided_by: null,
        decided_source: null,
        digest_verified: false,
        window_ms: windowMs,
        request: { ...request },
      };
      records.set(record.approval_id, record);
      persistRecord(record);
      return { ...record };
    },

    /**
     * Record an answer to a pending question.
     *
     * The answer has to be *this* question's answer. `digest`, when supplied,
     * must equal the record's binding: that is the out-of-band path, a person
     * reading the digest off the prompt and typing it back, and a mismatch means
     * the grant was for a different question. `source` says who is answering —
     * `flag` needs no name because no human is claiming to have answered,
     * `prompt` does, because an unattributed grant is not evidence that anyone
     * agreed.
     *
     * @param {string} approvalId
     * @param {'granted'|'denied'} status
     * @param {{by?: string, digest?: string|null, source?: DecisionSource}} [meta]
     * @returns {ApprovalRecord}
     */
    answer(approvalId, status, meta = {}) {
      expire();
      const record = records.get(approvalId);
      if (!record) throw new StoreError('APPROVAL_NOT_FOUND', `no approval ${approvalId}`);
      if (record.status !== 'pending') {
        throw new StoreError('APPROVAL_ALREADY_ANSWERED', `approval ${approvalId} is ${record.status}`);
      }
      if (status !== 'granted' && status !== 'denied') {
        throw new StoreError('APPROVAL_STATUS_INVALID', `an answer is 'granted' or 'denied', not ${String(status)}`);
      }
      const digest = meta.digest ?? null;
      if (digest !== null && digest !== record.binding) {
        throw new StoreError(
          'APPROVAL_BINDING_MISMATCH',
          `digest ${shortDigest(String(digest))} does not answer ` +
            `${shortDigest(record.binding)} (${record.request.action} ${record.request.target ?? '-'})`,
        );
      }
      const source = meta.source ?? 'prompt';
      /** @type {string} */
      let decidedBy;
      if (source === 'flag') {
        decidedBy = decidedByFlag(typeof meta.by === 'string' && meta.by.length > 0 ? meta.by : 'cli');
      } else if (source === 'prompt') {
        decidedBy = decidedByHuman(requireString(meta.by, 'by'));
      } else {
        throw new StoreError('APPROVAL_SOURCE_INVALID', `an answer comes from 'prompt' or 'flag', not ${String(source)}`);
      }
      record.status = status;
      record.decided_at = new Date(now()).toISOString();
      record.decided_by = decidedBy;
      // I store this rather than derive it from the prefix, so a reader of the
      // ledger file need not know that "flag:" means "no person answered".
      record.decided_source = source;
      record.digest_verified = digest !== null;
      persistRecord(record);
      return { ...record };
    },

    /**
     * Look up by id, after applying timeout rules.
     * @param {string} approvalId
     * @returns {ApprovalRecord|null}
     */
    get(approvalId) {
      expire();
      const record = records.get(approvalId);
      return record ? { ...record } : null;
    },

    /**
     * The status the policy needs for a request: the answer for *this* binding,
     * or null when the question has never been asked. A stale approval for a
     * different binding is deliberately not returned.
     *
     * @param {ApprovalRequest} request
     * @returns {ApprovalRecord|null}
     */
    statusFor(request) {
      expire();
      const binding = approvalBinding(request);
      /** @type {ApprovalRecord|null} */
      let latest = null;
      for (const record of records.values()) {
        if (record.binding !== binding) continue;
        if (!latest || Date.parse(record.requested_at) >= Date.parse(latest.requested_at)) latest = record;
      }
      return latest ? { ...latest } : null;
    },

    /**
     * All records, newest first. Used by tests and by `lain approve --list`.
     * @returns {ApprovalRecord[]}
     */
    list() {
      expire();
      return [...records.values()].sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1)).map((r) => ({ ...r }));
    },
  };
}
