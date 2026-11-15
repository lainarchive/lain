/**
 * @generated
 * @purpose  `lain model reclassify <model-id> <new-effect>` — authorized effect-class override (M-4)
 * @requires Chief-of-Staff
 */
import { ReclassificationError, reclassifyModel } from '../../model/reclassify.mjs';
import { ModelPolicyError } from '../../model/integration.mjs';

/** Kept equal to `EXIT` in `../index.mjs` for the same reason `approve.mjs` redeclares it. */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const USAGE = `lain model reclassify — override one model's effect class in memory (M-4)

  lain model reclassify <model-id> <new-effect>
      Ask the policy engine under the model.reclassify rule (requires
      model.admin) and, when permitted, record the override. The shipped
      registry stays frozen; the override is session-scoped and logged with
      the decision id that authorized it. One JSON document on stdout,
      exit 0 on success; exit 3 when the policy refused, 4 when the model id
      is unknown, 2 for usage errors.
`;

/**
 * @param {{ command?: string, positional: string[], flags: Record<string, string|boolean>, io: { out: (line: string) => void, err: (line: string) => void }}} args
 * @returns {number}
 */
export function modelReclassCommand({ command, positional, flags, io }) {
  const [modelId, newEffect] = command === 'reclassify' ? positional : [];
  if (modelId === undefined || newEffect === undefined) {
    io.err(USAGE);
    return EXIT.usage;
  }
  try {
    // The CLI is the human operator acting directly, so the path carries
    // model.admin itself; a task-driven path would pass the task's granted
    // capabilities instead and be refused without them.
    const outcome = reclassifyModel(modelId, newEffect, { granted_capabilities: ['model.admin'] });
    io.out(JSON.stringify(outcome, null, 2));
    return EXIT.ok;
  } catch (err) {
    if (err instanceof ModelPolicyError) {
      io.out(
        JSON.stringify(
          {
            reclassified: false,
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
    if (err instanceof ReclassificationError) {
      io.err(`failed: ${err.message}`);
      return EXIT.failed;
    }
    const reason = err instanceof Error ? err.message : String(err);
    io.err(`failed: ${reason}`);
    return EXIT.failed;
  }
}
