/**
 * Approvals.
 *
 * An approval is a record, not a conversation. The distinction matters because
 * the failure mode this module exists to prevent is an agent that treats "the
 * user did not say no" as "the user said yes".
 *
 * Rules:
 *   - Absence of an answer within the window is `timed_out`, which the policy
 *     turns into `deny_indeterminate` — a refusal that is NOT retryable, because
 *     the user's intent was never learned.
 *   - An explicit `denied` is also a refusal, but a retryable one: circumstances
 *     may change, and asking again after a change is not the same as ignoring the
 *     answer.
 *   - A decision is bound to the exact request it approved. A different tool,
 *     target or effect class is a different question.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../core/json.mjs';
import { ulid } from '../core/ids.mjs';
import { StoreError } from '../core/errors.mjs';
import { requireString } from '../core/validate.mjs';

/** @typedef {'pending'|'granted'|'denied'|'timed_out'} ApprovalStatus */

export const DEFAULT_APPROVAL_WINDOW_MS = 60_000;

/**
 * The identity of the question being asked. Two requests with the same binding
 * are the same question; anything else is a different one.
 *
 * @param {{action: string, tool_id?: string|null, target?: string|null, effect_class: string, task_id?: string|null}} request
 */
/**
 * @param {{action: string, tool_id?: string|null, target?: string|null, effect_class: string, task_id?: string|null}} request
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
 * An in-memory ledger with an optional durable backing store.
 *
 * The default is memory because the first milestone has no long-running process
 * to survive; the interface is async so that a durable implementation can be
 * substituted without changing a single call site. That is deliberate: an
 * approval that vanishes on restart is a security property, not a detail.
 *
 * @param {{now?: () => number, persist?: (record: object) => void|Promise<void>, load?: () => Promise<object[]>}} [options]
 */
export function createApprovalLedger(options = {}) {
  const now = options.now ?? Date.now;
  /**
   * @type {Map<string, {
   *   approval_id: string, binding: string, status: ApprovalStatus,
   *   requested_at: string, expires_at: string,
   *   decided_at: string|null, decided_by: string|null,
   *   window_ms: number, request: object,
   * }>}
   */
  const records = new Map();

  /** Mark any pending approval whose window has closed as timed out. */
  function expire() {
    const at = now();
    for (const record of records.values()) {
      if (record.status === 'pending' && Date.parse(record.expires_at) <= at) {
        record.status = 'timed_out';
        record.decided_at = new Date(at).toISOString();
        record.decided_by = 'timeout';
      }
    }
  }

  return {
    /**
     * Ask. Returns the existing pending approval for the same question if there
     * is one, so a retry cannot create a second prompt for the same decision.
     *
     * @param {object} request
     * @param {{window_ms?: number}} [opts]
     */
    /**
     * @param {{action: string, tool_id?: string|null, target?: string|null, effect_class: string, task_id?: string|null}} request
     * @param {{window_ms?: number}} [opts]
     */
    request(request, opts = {}) {
      expire();
      const binding = approvalBinding(request);
      for (const record of records.values()) {
        if (record.binding === binding && record.status === 'pending') return { ...record };
      }
      const windowMs = Number.isFinite(opts.window_ms) ? Number(opts.window_ms) : DEFAULT_APPROVAL_WINDOW_MS;
      const record = {
        approval_id: ulid(now()),
        binding,
        status: /** @type {ApprovalStatus} */ ('pending'),
        requested_at: new Date(now()).toISOString(),
        expires_at: new Date(now() + windowMs).toISOString(),
        decided_at: null,
        decided_by: null,
        window_ms: windowMs,
        request: { ...request },
      };
      records.set(record.approval_id, record);
      void options.persist?.(record);
      return { ...record };
    },

    /**
     * Record a human's answer. Only a pending approval can be answered, and the
     * answer must come with who gave it — an unattributed grant is not evidence.
     *
     * @param {string} approvalId
     * @param {'granted'|'denied'} status
     * @param {{by: string}} meta
     */
    /**
     * @param {string} approvalId
     * @param {'granted'|'denied'} status
     * @param {{by?: string}} [meta]
     */
    answer(approvalId, status, meta) {
      expire();
      const record = records.get(approvalId);
      if (!record) throw new StoreError('APPROVAL_NOT_FOUND', `no approval ${approvalId}`);
      if (record.status !== 'pending') {
        throw new StoreError('APPROVAL_ALREADY_ANSWERED', `approval ${approvalId} is ${record.status}`);
      }
      if (typeof meta?.by !== 'string' || meta.by.length === 0) {
        throw new StoreError('APPROVAL_UNATTRIBUTED', 'an approval answer must name who gave it');
      }
      record.status = status;
      record.decided_at = new Date(now()).toISOString();
      record.decided_by = requireString(meta.by, 'by');
      void options.persist?.(record);
      return { ...record };
    },

    /**
     * Look up by id, after applying timeout rules.
     * @param {string} approvalId
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
     * @param {object} request
     */
    /**
     * @param {{action: string, tool_id?: string|null, target?: string|null, effect_class: string, task_id?: string|null}} request
     */
    statusFor(request) {
      expire();
      const binding = approvalBinding(request);
      let latest = null;
      for (const record of records.values()) {
        if (record.binding !== binding) continue;
        if (!latest || Date.parse(record.requested_at) >= Date.parse(latest.requested_at)) latest = record;
      }
      return latest ? { ...latest } : null;
    },

    /** All records, newest first. Used by tests and by `lain policy explain`. */
    list() {
      expire();
      return [...records.values()].sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1)).map((r) => ({ ...r }));
    },
  };
}
