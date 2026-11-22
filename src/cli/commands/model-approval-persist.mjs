// `lain model approval-persist` — write the in-memory ledger to SQLite, or dump it back
import { existsSync } from 'node:fs';
import { StoreError } from '../../core/errors.mjs';
import { ModelPolicyError } from '../../model/integration.mjs';
import { listApprovals } from '../../model/approvalLedger.mjs';
import { createPersistentLedger } from '../../model/persistentLedger.mjs';

/** Kept equal to `EXIT` in `../index.mjs` for the same reason `approve.mjs` redeclares it. */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const USAGE = `lain model approval-persist — the durable approval ledger (M-6)

  lain model approval-persist store <db-path> [<decision-id> <task-id> <model-id> <outcome> [--by <who>]]
      With a decision: record one human decision straight into the SQLite
      ledger at <db-path>. Without: write every in-memory recorded decision
      (only meaningful in the same process that recorded them — the in-memory
      ledger is process-scoped). Each write asks the policy engine under the
      model.approval.persist rule (requires model.admin) — the CLI is the
      human operator acting directly, so it carries model.admin itself.
      A decision already persisted is skipped, so a re-store after a partial
      run resumes instead of failing.
      Outcome is one of: pending, granted, denied, timed_out.
      Exit 0 on success; 3 when the policy refused; 4 on a shape error;
      2 for usage errors.

  lain model approval-persist dump <db-path>
      Print every persisted decision as one JSON document (insertion order).
      No gate. The database is opened through the same ledger module, so a
      missing table is created (empty result); a missing file is exit 4.
`;

/**
 * @param {{ command?: string, positional: string[], flags: Record<string, string|boolean>, io: { out: (line: string) => void, err: (line: string) => void }}} args
 * @returns {number}
 */
export function modelApprovalPersistCommand({ command, positional, flags, io }) {
  if (command !== 'approval-persist') {
    io.err(USAGE);
    return EXIT.usage;
  }
  const [verb, dbPath, ...rest] = positional;
  if (verb === 'store') {
    if (dbPath === undefined || (rest.length > 0 && rest.length < 4)) {
      io.err(USAGE);
      return EXIT.usage;
    }
    const direct = rest.length >= 4 ? { decision_id: rest[0], taskId: rest[1], modelId: rest[2], outcome: rest[3], by: flags.by } : null;
    try {
      const ledger = createPersistentLedger(dbPath);
      try {
        let stored = 0;
        let skipped = 0;
        const entries = direct
          ? [
              {
                decision_id: /** @type {string} */ (direct.decision_id),
                taskId: /** @type {string} */ (direct.taskId),
                modelId: /** @type {string} */ (direct.modelId),
                outcome: /** @type {string} */ (direct.outcome),
                ...(typeof direct.by === 'string' && direct.by !== '' ? { decided_by: direct.by } : {}),
              },
            ]
          : listApprovals();
        for (const entry of entries) {
          try {
            ledger.add(entry, { granted_capabilities: ['model.admin'] });
            stored += 1;
          } catch (err) {
            if (err instanceof StoreError && err.message.startsWith('duplicate approval record')) {
              skipped += 1;
              continue;
            }
            throw err;
          }
        }
        io.out(JSON.stringify({ stored, skipped, db: dbPath }, null, 2));
        return EXIT.ok;
      } finally {
        ledger.close();
      }
    } catch (err) {
      if (err instanceof ModelPolicyError) {
        io.out(
          JSON.stringify(
            {
              stored: 0,
              code: err.code,
              decision_id_of_refusal: err.decision.decision_id,
              arm_id: err.decision.arm_id,
              reason: err.decision.reason,
            },
            null,
          ),
        );
        return EXIT.refused;
      }
      const reason = err instanceof Error ? err.message : String(err);
      io.err(`failed: ${reason}`);
      return EXIT.failed;
    }
  }
  if (verb === 'dump') {
    if (dbPath === undefined || rest.length > 0) {
      io.err(USAGE);
      return EXIT.usage;
    }
    if (!existsSync(dbPath)) {
      io.err(`failed: no providers database: ${dbPath}`);
      return EXIT.failed;
    }
    const ledger = createPersistentLedger(dbPath);
    try {
      io.out(JSON.stringify({ approvals: ledger.list() }, null, 2));
      return EXIT.ok;
    } finally {
      ledger.close();
    }
  }
  io.err(USAGE);
  return EXIT.usage;
}
