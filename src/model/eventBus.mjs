/**
 * @generated
 * @purpose  The task event bus — the one channel Core events cross to reach live observers (M-9)
 * @requires Chief-of-Staff
 */
import { EventEmitter } from 'node:events';

/**
 * The record shape every publisher hands to the bus. It mirrors what the task
 * runner records (event_type, payload, task_id) plus the wall clock the
 * publisher saw; observers must not treat it as the stored row — the store
 * remains the only durable record.
 *
 * @typedef {object} TaskEventRecord
 * @property {string} event_type
 * @property {Record<string, unknown>} [payload]
 * @property {string} [task_id]
 * @property {string} [occurred_at]
 * @property {string} [correlation_id]
 * @property {string} [causation_id]
 */

/** The one event name the bus publishes task records under. */
export const TASK_EVENT = 'task.event';

/**
 * A fresh bus. One emitter per process keeps backpressure honest: a listener
 * that cannot keep up slows the publisher visibly instead of hiding behind a
 * queue it does not own.
 * @returns {EventEmitter}
 */
export function createEventBus() {
  const bus = new EventEmitter();
  // The dashboard is the only intended listener today; headroom keeps a second
  // observer from turning a routine publish into a MaxListeners warning.
  bus.setMaxListeners(20);
  return bus;
}

/** The process-wide bus. Core publishes; the TUI subscribes. */
export const eventBus = createEventBus();

/**
 * Publish one task event. Fire-and-forget by design: a live observer must
 * never be able to break a task's recording, so the publish happens after the
 * store has accepted the event and any listener failure stays isolated in
 * that listener (EventEmitter semantics).
 *
 * @param {TaskEventRecord} record
 * @param {{ bus?: EventEmitter }} [options] inject a bus in tests; defaults to the process-wide one
 * @returns {TaskEventRecord} the same record, for call-site convenience
 */
export function publishTaskEvent(record, options = {}) {
  (options.bus ?? eventBus).emit(TASK_EVENT, record);
  return record;
}
