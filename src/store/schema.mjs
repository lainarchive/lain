import { StoreError } from '../core/errors.mjs';
import { isUlid, correlationId } from '../core/ids.mjs';
import { canonicalHash } from '../core/json.mjs';
import { requireRecord, requireString, requireInteger, typeName } from '../core/validate.mjs';
import { preparePayload } from './redact.mjs';

/**
 * The event shape actually persisted by src/store. This is the schema M-1
 * implements; the fuller shape described in the research specification can grow
 * into it through schema_version without rewriting stored rows.
 */

export const SCHEMA_VERSION = 1;
export const EVENT_TYPES_VERSION = 1;

/** Event types M-1 knows about. An unknown type is stored but flagged, never rejected on the producer's behalf. */
export const KNOWN_EVENT_TYPES = Object.freeze([
  'store.opened',
  'store.closed',
  'store.lock.refused',
  'store.schema.migrated',
  'store.recovery.performed',
  'store.integrity.checked',
  'store.backup.taken',
  'store.payload.refused',
  'host.probed',
  'task.admitted',
  'task.state.changed',
  'task.result.proposed',
  'task.cancelled',
  'policy.decided',
  'model.bound',
  'model.called',
  'model.refused',
  'tool.executed',
  'tool.denied',
  'check.passed',
  'check.failed',
]);

const MAX_TYPE_LENGTH = 120;
const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_TEXT_FIELD = 500;

/**
 * A validated event, ready to be written. The fields the store owns (seq,
 * recorded_at) are added at insert time, not here.
 *
 * @typedef {object} ValidatedEvent
 * @property {string} event_id
 * @property {string} event_type
 * @property {number} schema_version
 * @property {string} occurred_at
 * @property {string} session_id
 * @property {string | null} task_id
 * @property {string} producer
 * @property {string} correlation_id
 * @property {string | null} causation_id
 * @property {string} payload_text
 * @property {string} payload_hash
 * @property {{applied: boolean, rules: {key_name: number, value_pattern: number}}} redaction
 */

/**
 * Validate and normalize an event draft. Throws StoreError on an invalid draft:
 * the store never guesses an id, a timestamp or a producer on the caller's behalf,
 * because those fields are what make the record attributable later.
 *
 * @param {unknown} draft
 * @param {{now?: number, defaultProducer?: string}} [opts]
 * @returns {ValidatedEvent}
 */
export function validateDraft(draft, opts = {}) {
  requireRecord(draft, 'event draft');
  const d = /** @type {Record<string, unknown>} */ (draft);

  const eventId = d.event_id ?? (opts.now === undefined ? correlationId() : undefined);
  if (eventId === undefined) {
    throw new StoreError('MISSING_EVENT_ID', 'the event draft has no event_id', { draft: Object.keys(d) });
  }
  const eventIdText = requireString(eventId, 'event_id', { min: 1, max: 64 });
  if (!isUlid(eventIdText)) {
    throw new StoreError('INVALID_EVENT_ID', 'event_id must be a ULID', { event_id: eventIdText });
  }

  const eventTypeText = requireString(d.event_type, 'event_type', { min: 1, max: MAX_TYPE_LENGTH });
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/.test(eventTypeText)) {
    throw new StoreError('INVALID_EVENT_TYPE', 'event_type must be dotted lower-case segments', { event_type: eventTypeText });
  }

  const schemaVersion = requireInteger(d.schema_version ?? SCHEMA_VERSION, 'schema_version', { min: 1, max: 1000 });
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new StoreError('UNSUPPORTED_SCHEMA_VERSION', `schema_version ${schemaVersion} is not supported by this store (expects ${SCHEMA_VERSION})`, {
      schema_version: schemaVersion,
      supported: SCHEMA_VERSION,
    });
  }

  const occurredAt = requireString(d.occurred_at, 'occurred_at', { min: 20, max: 40 });
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new StoreError('INVALID_TIMESTAMP', 'occurred_at must be an ISO-8601 timestamp', { occurred_at: occurredAt });
  }

  const sessionId = d.session_id;
  if (sessionId !== undefined && sessionId !== null) {
    requireString(sessionId, 'session_id', { min: 1, max: MAX_TEXT_FIELD });
  }

  const taskId = d.task_id;
  if (taskId !== undefined && taskId !== null) {
    requireString(taskId, 'task_id', { min: 1, max: MAX_TEXT_FIELD });
  }

  const producer = requireString(d.producer ?? opts.defaultProducer, 'producer', { min: 1, max: MAX_TEXT_FIELD });

  const correlation = requireString(d.correlation_id ?? `cor_${eventIdText}`, 'correlation_id', { min: 1, max: MAX_TEXT_FIELD });

  const causation = d.causation_id === undefined || d.causation_id === null
    ? null
    : requireString(d.causation_id, 'causation_id', { min: 1, max: MAX_TEXT_FIELD });

  const sessionText = sessionId === undefined || sessionId === null
    ? 'session_unassigned'
    : requireString(sessionId, 'session_id', { min: 1, max: MAX_TEXT_FIELD });
  const taskText = taskId === undefined || taskId === null
    ? null
    : requireString(taskId, 'task_id', { min: 1, max: MAX_TEXT_FIELD });

  if (!Object.hasOwn(d, 'payload')) {
    throw new StoreError('MISSING_PAYLOAD', 'the event draft has no payload', { event_type: eventTypeText });
  }

  const prepared = preparePayload(d.payload);
  if (prepared.text.length > MAX_PAYLOAD_BYTES) {
    throw new StoreError('PAYLOAD_TOO_LARGE', `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`, {
      bytes: prepared.text.length,
      ceiling: MAX_PAYLOAD_BYTES,
    });
  }

  return {
    event_id: eventIdText,
    event_type: eventTypeText,
    schema_version: schemaVersion,
    occurred_at: occurredAt,
    session_id: sessionText,
    task_id: taskText,
    producer,
    correlation_id: correlation,
    causation_id: causation,
    payload_text: prepared.text,
    payload_hash: canonicalHash(JSON.parse(prepared.text)),
    redaction: prepared.redaction,
  };
}

/**
 * Build a stored-row object from a validated draft plus the fields the store owns.
 *
 * @param {ReturnType<typeof validateDraft>} validated
 * @param {{seq: number, recorded_at: string}} owned
 * @returns {Record<string, unknown>}
 */
export function toRow(validated, owned) {
  return {
    seq: owned.seq,
    event_id: validated.event_id,
    event_type: validated.event_type,
    schema_version: validated.schema_version,
    occurred_at: validated.occurred_at,
    recorded_at: owned.recorded_at,
    session_id: validated.session_id,
    task_id: validated.task_id,
    producer: validated.producer,
    correlation_id: validated.correlation_id,
    causation_id: validated.causation_id,
    payload_text: validated.payload_text,
    payload_hash: validated.payload_hash,
    redaction_applied: validated.redaction.applied ? 1 : 0,
    redaction_rules: JSON.stringify(validated.redaction.rules),
  };
}

/**
 * Turn a stored row back into an event for a reader. The payload is parsed here
 * so a caller never has to decide whether the stored text is JSON.
 *
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
export function fromRow(row) {
  let payload;
  try {
    payload = JSON.parse(/** @type {string} */ (row.payload_text));
  } catch {
    throw new StoreError('CORRUPT_PAYLOAD', `stored payload for event ${String(row.event_id)} is not valid JSON`, {
      event_id: row.event_id,
      seq: row.seq,
    });
  }
  return {
    seq: row.seq,
    event_id: row.event_id,
    event_type: row.event_type,
    schema_version: row.schema_version,
    occurred_at: row.occurred_at,
    recorded_at: row.recorded_at,
    session_id: row.session_id,
    task_id: row.task_id,
    producer: row.producer,
    correlation_id: row.correlation_id,
    causation_id: row.causation_id,
    payload,
    payload_hash: row.payload_hash,
    redaction: {
      applied: row.redaction_applied === 1,
      rules: typeof row.redaction_rules === 'string' ? JSON.parse(row.redaction_rules) : row.redaction_rules,
    },
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function describeDraft(value) {
  if (value === null || typeof value !== 'object') return typeName(value);
  return `{${Object.keys(/** @type {object} */ (value)).join(',')}}`;
}
