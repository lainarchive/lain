// `lain model run <task.json>` — the M-2 mock model entry point
import { readFileSync } from 'node:fs';
import { ModelPolicyError, runTask } from '../../model/integration.mjs';

/**
 * Kept equal to `EXIT` in `../index.mjs`, for the same reason `approve.mjs`
 * redeclares it: importing it would cycle the dispatcher that calls this.
 */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const USAGE = `lain model — run one mock model invocation (M-2)

  lain model run <task.json>
      Read the task file, ask the policy engine for 'model.invoke', and print
      the JSON outcome to stdout. The task declares what it needs in
      'required_capabilities' and what it holds in 'granted_capabilities';
      the policy decides on the difference, not on the request.
`;

/**
 * @param {{ command?: string, positional: string[], flags: Record<string, string|boolean>, io: { out: (line: string) => void, err: (line: string) => void }}} args
 * @returns {number}
 */
export function modelCommand({ command, positional, flags, io }) {
  // Narrow the path for the type checker as well as the reader: indexed
  // access stays `string | undefined` no matter what the length guard saw.
  const taskPath = command === 'run' ? positional[0] : undefined;
  if (taskPath === undefined) {
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
  try {
    const declared = /** @type {{ granted_capabilities?: unknown }} */ (raw)?.granted_capabilities;
    const outcome = runTask(raw, {
      granted_capabilities: Array.isArray(declared) ? /** @type {string[]} */ (declared) : [],
    });
    // One JSON document on stdout, so a consumer can pipe it straight into a
    // parser; the decision narrative goes to stderr, not into the document.
    io.out(JSON.stringify(outcome, null, 2));
    return EXIT.ok;
  } catch (err) {
    if (err instanceof ModelPolicyError) {
      io.err(`refused: ${err.message}`);
      io.err(`decision    ${err.decision.arm_id} ${err.decision.outcome} (${err.decision.reason_code})`);
      return EXIT.refused;
    }
    const reason = err instanceof Error ? err.message : String(err);
    io.err(`failed: ${reason}`);
    return EXIT.failed;
  }
}
