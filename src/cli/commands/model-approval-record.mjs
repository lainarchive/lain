// `lain model approval-record` — write or read the human-approval ledger
import { StoreError } from '../../core/errors.mjs';
import { ModelPolicyError } from '../../model/integration.mjs';
import { listApprovals, recordApproval } from '../../model/approvalLedger.mjs';

/** Kept equal to `EXIT` in `../index.mjs` for the same reason `approve.mjs` redeclares it. */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const USAGE = `lain model approval-record — the human-approval ledger (M-5)

  lain model approval-record list
      Print every recorded decision as one JSON document (insertion order).
      Read-only; no gate.

  lain model approval-record add <decision-id> <task-id> <model-id> <outcome> [--by <who>]
      Record one human decision. The write asks the policy engine under the
      model.approval.record rule (requires model.admin) — the CLI is the
      human operator acting directly, so it carries model.admin itself.
      Outcome is one of: pending, granted, denied, timed_out.
      Exit 0 on success; 3 when the policy refused; 4 on a shape error;
      2 for usage errors.
`;

/**
 * @param {{ command?: string, positional: string[], flags: Record<string, string|boolean>, io: { out: (line: string) => void, err: (line: string) => void }}} args
 * @returns {number}
 */
export function modelApprovalRecordCommand({ command, positional, flags, io }) {
  if (command !== 'approval-record') {
    io.err(USAGE);
    return EXIT.usage;
  }
  const [verb, ...rest] = positional;
  if (verb === 'list') {
    io.out(JSON.stringify({ approvals: listApprovals() }, null, 2));
    return EXIT.ok;
  }
  if (verb === 'add') {
    const [decisionId, taskId, modelId, outcome] = rest;
    if (decisionId === undefined || taskId === undefined || modelId === undefined || outcome === undefined) {
      io.err(USAGE);
      return EXIT.usage;
    }
    const by = flags.by;
    const entry = {
      decision_id: decisionId,
      taskId,
      modelId,
      outcome,
      ...(typeof by === 'string' && by !== '' ? { decided_by: by } : {}),
    };
    try {
      const stored = recordApproval(entry, { granted_capabilities: ['model.admin'] });
      io.out(JSON.stringify(stored, null, 2));
      return EXIT.ok;
    } catch (err) {
      if (err instanceof ModelPolicyError) {
        io.out(
          JSON.stringify(
            {
              recorded: false,
              decision_id: decisionId,
              code: err.code,
              decision_id_of_refusal: err.decision.decision_id,
              arm_id: err.decision.arm_id,
              reason: err.decision.reason,
            },
            null,
            2,
          ),
        );
        return EXIT.refused;
      }
      if (err instanceof StoreError) {
        io.err(`failed: ${err.message}`);
        return EXIT.failed;
      }
      const reason = err instanceof Error ? err.message : String(err);
      io.err(`failed: ${reason}`);
      return EXIT.failed;
    }
  }
  io.err(USAGE);
  return EXIT.usage;
}
