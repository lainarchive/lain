// `lain model loop --task <file.json>` — M-10 bounded agent loop CLI entry point
import { existsSync, readFileSync } from 'node:fs';
import { runModelLoop } from '../../agent/loop.mjs';
import { createPersistentLedger } from '../../model/persistentLedger.mjs';
import { getCredentials } from '../../model/provider/credentials.mjs';
import { queryLive } from '../../model/provider/gemini.mjs';

/** Kept equal to `EXIT` in `../index.mjs`, same reason as `model-invoke.mjs`. */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const USAGE = `lain model loop — run a bounded model loop against one task

  lain model loop --task <file.json> [--live --approval-id <decision-id> --ledger <db-path>] [--json]

  Without --live, uses the $0 mock transport. With --live, requires both
  --approval-id and --ledger and routes through Gemini free-tier transport.

  Exit 0 on completed; 3 on policy refusal or missing live credential;
  4 on budget exceeded or failure; 2 on usage or task-file errors.
`;

/**
 * @param {{ command?: string, positional?: string[], flags: Record<string, string|boolean>, io: { out: (line: string) => void, err: (line: string) => void }, fetchImpl?: typeof fetch }} args
 * @returns {Promise<number>}
 */
export async function modelLoopCommand({ command, flags, io, fetchImpl }) {
  if (command !== 'loop') {
    io.err(USAGE);
    return EXIT.usage;
  }

  const live = flags.live === true || flags.live === 'true';
  const taskPath = typeof flags.task === 'string' && flags.task !== '' ? flags.task : undefined;
  const approvalId = typeof flags['approval-id'] === 'string' && flags['approval-id'] !== '' ? flags['approval-id'] : undefined;
  const ledgerPath = typeof flags.ledger === 'string' && flags.ledger !== '' ? flags.ledger : undefined;

  if (taskPath === undefined || (live && (approvalId === undefined || ledgerPath === undefined))) {
    io.err(USAGE);
    return EXIT.usage;
  }

  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(taskPath, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    io.err(`usage: cannot read task file — ${reason}`);
    return EXIT.usage;
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    io.err('usage: task file must be a JSON object');
    return EXIT.usage;
  }

  const task = /** @type {{ id?: unknown, objective?: unknown, prompt?: unknown, granted_capabilities?: unknown, budget?: unknown }} */ (raw);
  const objective =
    typeof task.objective === 'string' && task.objective !== ''
      ? task.objective
      : typeof task.prompt === 'string' && task.prompt !== ''
        ? task.prompt
        : undefined;
  if (objective === undefined) {
    io.err('usage: task file needs a non-empty string objective or prompt');
    return EXIT.usage;
  }

  const taskId = typeof task.id === 'string' && task.id !== '' ? task.id : taskPath;
  const granted = Array.isArray(task.granted_capabilities) ? /** @type {string[]} */ (task.granted_capabilities) : [];
  const budget = task.budget !== null && typeof task.budget === 'object' && !Array.isArray(task.budget) ? /** @type {Record<string, unknown>} */ (task.budget) : undefined;

  /** @type {ReturnType<typeof createPersistentLedger> | undefined} */
  let ledger;
  if (ledgerPath !== undefined) {
    if (!existsSync(ledgerPath)) {
      io.err(`failed: approval ledger not found: ${ledgerPath}`);
      return EXIT.failed;
    }
    ledger = createPersistentLedger(ledgerPath);
  }

  try {
    /**
     * @type {((ctx: { step: number, messages: Array<{ role: string, content: string }>, taskId: string }) =>
     *   Promise<{ answer: string, cost?: number, model?: string, provider?: string }>) | undefined}
     */
    let transport;
    if (live) {
      const credentials = getCredentials('gemini');
      if (credentials.apiKey === null) {
        io.err(`refused: no credential for gemini — set AGY_ACCOUNT or the repo .env file (source: ${credentials.source})`);
        return EXIT.refused;
      }
      const apiKey = credentials.apiKey;
      transport = async ({ messages }) => {
        const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
        const res = await queryLive(prompt, {
          apiKey,
          ...(fetchImpl !== undefined ? { fetchImpl } : {}),
        });
        return { answer: res.answer, provider: res.provider, model: res.model, cost: 0 };
      };
    }

    const outcome = await runModelLoop({
      taskId,
      objective,
      granted_capabilities: granted,
      ...(budget !== undefined ? { budget } : {}),
      live,
      ...(approvalId !== undefined ? { approvalId } : {}),
      ...(ledger !== undefined ? { ledger } : {}),
      ...(transport !== undefined ? { transport } : {}),
    });

    if (flags.json) {
      io.out(JSON.stringify(outcome, null, 2));
    } else if (outcome.status === 'completed') {
      io.out(`task    ${taskId}`);
      io.out(`status  ${outcome.status}`);
      io.out(`steps   ${outcome.steps} (model: ${outcome.model_calls}, tool: ${outcome.tool_calls})`);
      if ('answer' in outcome && outcome.answer !== undefined) io.out(`answer  ${outcome.answer}`);
    } else {
      const prefix = outcome.status === 'refused' ? 'refused' : 'failed';
      const detail = 'reason' in outcome && outcome.reason ? outcome.reason : outcome.status;
      io.err(`${prefix}: ${detail}`);
      if ('decision' in outcome && outcome.decision) {
        const d = /** @type {{ arm_id?: string, outcome?: string, reason_code?: string }} */ (outcome.decision);
        io.err(`decision  ${d.arm_id} ${d.outcome} (${d.reason_code})`);
      }
    }

    if (outcome.status === 'completed') return EXIT.ok;
    if (outcome.status === 'refused') return EXIT.refused;
    return EXIT.failed;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    io.err(`failed: ${reason}`);
    return EXIT.failed;
  } finally {
    ledger?.close();
  }
}
