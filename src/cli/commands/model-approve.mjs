// `lain model approve <task.json> <model-id>` — probe the human-approval gate
import { readFileSync } from 'node:fs';
import { HumanApprovalNeeded, requireHumanApproval } from '../../model/approval.mjs';
import { ModelPolicyError } from '../../model/integration.mjs';

/** Kept equal to `EXIT` in `../index.mjs` for the same reason `approve.mjs` redeclares it. */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const USAGE = `lain model approve — ask the human-approval gate about one model invocation (M-3)

  lain model approve <task.json> <model-id>
      Run the gate for the task and model: the policy engine decides, and the
      outcome is one JSON document on stdout. Exit 0 when no human is needed;
      exit 3 when the decision belongs to a human (A5) or the policy refused.
      This command never approves anything — recording a human's answer is
      the existing 'lain approve' flow.
`;

/**
 * @param {{ command?: string, positional: string[], flags: Record<string, string|boolean>, io: { out: (line: string) => void, err: (line: string) => void }}} args
 * @returns {number}
 */
export function modelApproveCommand({ command, positional, flags, io }) {
  // Narrow both positional args for the type checker as well as the reader:
  // indexed access stays `string | undefined` no matter what the length guard saw.
  const [taskPath, modelId] = command === 'approve' ? positional : [];
  if (taskPath === undefined || modelId === undefined) {
    io.err(USAGE);
    return EXIT.usage;
  }
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(taskPath, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    io.err(`refused: cannot read task file — ${reason}`);
    return EXIT.usage;
  }
  const declared = /** @type {{ granted_capabilities?: unknown }} */ (raw)?.granted_capabilities;
  const granted = Array.isArray(declared) ? /** @type {string[]} */ (declared) : [];
  try {
    const outcome = requireHumanApproval(/** @type {{ id: string }} */ (raw), modelId, {
      granted_capabilities: granted,
    });
    io.out(JSON.stringify(outcome, null, 2));
    return EXIT.ok;
  } catch (err) {
    if (err instanceof HumanApprovalNeeded) {
      // One parseable document either way; the exit code is the verdict.
      io.out(
        JSON.stringify(
          {
            required: true,
            taskId: err.taskId,
            modelId: err.modelId,
            code: err.code,
            decision_id: err.decision_id,
            arm_id: err.decision.arm_id,
            reason: err.decision.reason,
          },
          null,
          2,
        ),
      );
      return EXIT.refused;
    }
    if (err instanceof ModelPolicyError) {
      io.out(
        JSON.stringify(
          {
            required: true,
            modelId,
            code: err.code,
            decision_id: err.decision.decision_id,
            arm_id: err.decision.arm_id,
            reason: err.decision.reason,
          },
          null,
          2,
        ),
      );
      return EXIT.refused;
    }
    const reason = err instanceof Error ? err.message : String(err);
    io.err(`failed: ${reason}`);
    return EXIT.failed;
  }
}
