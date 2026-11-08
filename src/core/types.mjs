/**
 * Shared type shapes.
 *
 * These exist so the boundary between modules is written down once. Every type
 * here is a *contract* the runtime checks, not a documentation convenience: a
 * `Criterion` that does not match this shape is refused by `validateTaskDraft`.
 *
 * @typedef {'command' | 'artifact' | 'assertion'} CriterionKind
 *
 * @typedef {object} CriterionCheck
 * @property {CriterionKind} kind
 * @property {string} [path]
 * @property {number} [exit_code]
 * @property {string} [spec]
 * @property {unknown} [extra]
 *
 * @typedef {object} Criterion
 * @property {string} id
 * @property {string} statement
 * @property {CriterionCheck} check
 * @property {boolean} required
 *
 * @typedef {object} TaskBudget
 * @property {number} max_tool_calls
 * @property {number} max_processes
 * @property {number} max_wall_ms
 * @property {number} max_output_bytes
 * @property {number} max_model_calls
 *
 * @typedef {object} TaskContract
 * @property {string} objective
 * @property {Criterion[]} acceptance_criteria
 * @property {string[]} capabilities
 * @property {string} effect_class
 * @property {boolean} effect_class_known
 * @property {string|null} workspace
 * @property {TaskBudget} budget
 * @property {string} requested_at
 *
 * @typedef {object} CriterionResult
 * @property {string} id
 * @property {string} statement
 * @property {boolean} required
 * @property {'passed' | 'failed' | 'not_evaluated'} verdict
 * @property {string} detail
 *
 * @typedef {object} ArtifactRef
 * @property {string} path
 * @property {number} bytes
 *
 * @typedef {object} ToolOutcome
 * @property {string} status
 * @property {string} decision_id
 * @property {string} [tool_id]
 * @property {boolean} executed
 * @property {Record<string, unknown>} [result]
 * @property {string} [outcome]
 * @property {string} [reason_code]
 * @property {string[]} [missing]
 * @property {{code: string, message: string}} [error]
 * @property {number} [duration_ms]
 * @property {string[]} [conditions]
 *
 * @typedef {object} TaskResult
 * @property {{claim: string, supported_by: string|null}[]} claims
 * @property {ArtifactRef[]} artifacts
 * @property {Record<string, unknown>[]} evidence
 * @property {CriterionResult[]} checks
 * @property {{id: string, detail: string}[]} not_verified
 * @property {{what: string, why: string}[]} indeterminate
 * @property {string[]} decision_ids
 * @property {{tool_id: string, status: string, reason_code: string|null}} tool
 *
 * @typedef {object} TaskRecord
 * @property {string} task_id
 * @property {string} objective
 * @property {string} state
 * @property {string} effect_class
 * @property {string|null} workspace
 * @property {TaskBudget} budget
 * @property {TaskContract} contract
 * @property {TaskResult|null} result
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string} origin
 *
 * @typedef {object} HistoryRow
 * @property {number} seq
 * @property {string} from
 * @property {string} to
 * @property {string} at
 * @property {string|null} reason
 * @property {Record<string, unknown>|null} evidence
 *
 * @typedef {object} TaskStore
 * @property {string} path
 * @property {(args: {contract: TaskContract, origin?: string}) => {task_id: string, state: string, created_at: string}} create
 * @property {(taskId: string) => TaskRecord} get
 * @property {(taskId: string, capabilities: string[], meta: {granted_by: string}) => string[]} grantCapabilities
 * @property {(taskId: string) => string[]} capabilities
 * @property {(
 *   taskId: string,
 *   to: string,
 *   opts?: {
 *     reason?: string|null,
 *     evidence?: {requiredChecksPassed?: boolean, survivingProcesses?: number|null},
 *   },
 * ) => {task_id: string, from: string, to: string, at: string}} transition
 * @property {(taskId: string, result: TaskResult) => TaskResult|null} setResult
 * @property {(taskId: string) => HistoryRow[]} history
 * @property {(limit?: number) => unknown[]} list
 * @property {(taskId: string) => {ok: boolean, findings: {code: string}[], state?: string}} verify
 * @property {() => {tasks: number, schema_version: number}} stats
 * @property {() => void} close
 *
 * @typedef {object} EventLog
 * @property {string} path
 * @property {Record<string, unknown>} writer
 * @property {number} schema_version
 * @property {(drafts: unknown[]) => {batch_id: string, from_seq: number, to_seq: number, count: number}} append
 * @property {(eventType: string, payload: Record<string, unknown>, extra?: {correlation_id?: string, causation_id?: string, session_id?: string, task_id?: string}) => unknown} record
 * @property {(query?: Record<string, unknown>) => unknown[]} read
 * @property {(eventId: string) => unknown} get
 * @property {() => {count: number, schema_version: number}} stats
 * @property {(opts?: {deep?: boolean}) => {ok: boolean, checks: {name: string, ok: boolean, detail?: string}[]}} verify
 * @property {(opts: {path: string}) => Promise<{path: string, pages: number, lock_reacquired: boolean}>} backup
 * @property {boolean} holds_write_lock
 * @property {() => void} close
 *
 * @typedef {object} WorkspaceHandle
 * @property {string} path
 * @property {string} temp
 * @property {() => string} create
 * @property {(relativePath: string) => {ok: boolean, code?: string, path?: string, detail?: Record<string, unknown>}} resolve
 * @property {(relativePath: string) => string} file
 * @property {(relativePath: string, contents: string) => {path: string, bytes: number}} write
 * @property {(spec: {command: string, args?: string[], timeoutMs: number, maxOutputBytes: number, cwd?: string}) => Record<string, unknown>} run
 * @property {() => ArtifactRef[]} contents
 * @property {() => {removed: string, exists: boolean}} destroy
 *
 * @typedef {object} Registry
 * @property {(definition: import('../tools/registry.mjs').ToolDefinition) => import('../tools/registry.mjs').ToolDefinition} register
 * @property {(toolId: string) => import('../tools/registry.mjs').ToolDefinition|null} get
 * @property {() => {tool_id: string, summary: string, effect_class: string, requires: string[], spawns_processes: boolean}[]} list
 * @property {(toolId: string) => string[]} requiredCapabilities
 *
 * @typedef {object} PolicyDecision
 * @property {string} decision_id
 * @property {import('../policy/arms.mjs').Outcome} outcome
 * @property {string} arm_id
 * @property {string} reason_code
 * @property {string|null} error
 * @property {string} reason
 * @property {string[]} conditions
 * @property {string|null} approval_id
 * @property {string} effect_class
 * @property {string} action
 * @property {string|null} target
 * @property {string} decided_at
 * @property {string} decided_by
 * @property {boolean} retryable
 *
 * @typedef {object} RunnerOutcome
 * @property {string} task_id
 * @property {string} state
 * @property {PolicyDecision|null} admission
 * @property {ToolOutcome|null} invocation
 * @property {TaskResult|null} result
 * @property {string|null} workspace
 */

export {};
