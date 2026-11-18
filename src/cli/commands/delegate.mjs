/**
 * @purpose  `lain delegate <list|run>` — Phase 5 bounded specialist delegation CLI
 */
import { readFileSync } from 'node:fs';
import { SPECIALISTS, delegateTask } from '../../agent/delegate.mjs';

/** Kept equal to `EXIT` in `../index.mjs`, same reason as `model-invoke.mjs`. */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const DEFAULT_PARENT_BUDGET = {
  max_steps: 8,
  max_model_calls: 4,
  max_tool_calls: 4,
  max_wall_ms: 30_000,
};

const USAGE = `lain delegate — list or run bounded specialist delegation

  lain delegate list [--json]
  lain delegate run --task <file.json> [--specialist <id>] [--depth <n>] [--json]

  Defaults to --specialist researcher and --depth 0, using $0 mock transport.
  Exit 0 on completed; 3 on policy/delegation refusal; 4 on failure;
  2 on usage or task-file errors.
`;

/**
 * @param {Record<string, string|boolean>} flags
 * @param {{ out: (line: string) => void, err: (line: string) => void }} io
 * @returns {number}
 */
function runList(flags, io) {
  const rows = Object.entries(SPECIALISTS).map(([id, spec]) => ({
    id,
    allowed_capabilities: spec.allowed_capabilities,
    max_steps: spec.max_steps,
    max_model_calls: spec.max_model_calls,
    max_tool_calls: spec.max_tool_calls,
  }));

  if (flags.json) {
    io.out(JSON.stringify(rows, null, 2));
    return EXIT.ok;
  }

  for (const row of rows) {
    const caps = row.allowed_capabilities.join(', ');
    io.out(`${row.id.padEnd(13)} steps=${row.max_steps} model=${row.max_model_calls} tool=${row.max_tool_calls} caps=[${caps}]`);
  }
  return EXIT.ok;
}

/**
 * @param {Record<string, string|boolean>} flags
 * @param {{ out: (line: string) => void, err: (line: string) => void }} io
 * @returns {Promise<number>}
 */
async function runDelegate(flags, io) {
  const taskPath = typeof flags.task === 'string' && flags.task !== '' ? flags.task : undefined;
  if (taskPath === undefined) {
    io.err(USAGE);
    return EXIT.usage;
  }

  let specialistId = 'researcher';
  if (flags.specialist !== undefined) {
    if (typeof flags.specialist !== 'string' || flags.specialist === '') {
      io.err(USAGE);
      return EXIT.usage;
    }
    specialistId = flags.specialist;
  }

  let depth = 0;
  if (flags.depth !== undefined) {
    if (typeof flags.depth !== 'string' || !/^\d+$/.test(flags.depth)) {
      io.err('usage: --depth must be a non-negative integer');
      return EXIT.usage;
    }
    depth = Number(flags.depth);
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

  const task = /** @type {{ id?: unknown, objective?: unknown, prompt?: unknown, granted_capabilities?: unknown, budget?: unknown, context_notes?: unknown }} */ (raw);
  const objective =
    typeof task.objective === 'string' && task.objective.trim() !== ''
      ? task.objective
      : typeof task.prompt === 'string' && task.prompt.trim() !== ''
        ? task.prompt
        : undefined;
  if (objective === undefined) {
    io.err('usage: task file needs a non-empty string objective or prompt');
    return EXIT.usage;
  }

  const parentTaskId = typeof task.id === 'string' && task.id !== '' ? task.id : taskPath;
  const parentCapabilities = Array.isArray(task.granted_capabilities) ? /** @type {string[]} */ (task.granted_capabilities) : [];
  const parentBudget =
    task.budget !== null && typeof task.budget === 'object' && !Array.isArray(task.budget)
      ? /** @type {Record<string, number>} */ (task.budget)
      : DEFAULT_PARENT_BUDGET;
  const contextNotes = typeof task.context_notes === 'string' && task.context_notes !== '' ? task.context_notes : undefined;

  try {
    const result = await delegateTask({
      parentTaskId,
      specialistId,
      objective,
      parentCapabilities,
      parentBudget,
      ...(contextNotes !== undefined ? { contextNotes } : {}),
      depth,
    });

    if (flags.json) {
      io.out(JSON.stringify(result, null, 2));
    } else if (result.status === 'completed') {
      io.out(`parent      ${parentTaskId}`);
      io.out(`specialist  ${result.specialist}`);
      io.out(`depth       ${result.depth}`);
      io.out(`status      ${result.status}`);
      if (typeof result.outcome === 'object' && result.outcome !== null && 'answer' in result.outcome && result.outcome.answer !== undefined) {
        io.out(`answer      ${result.outcome.answer}`);
      }
    } else {
      const prefix = result.status === 'refused' ? 'refused' : 'failed';
      const detail = 'reason' in result && result.reason ? result.reason : result.verification_note || result.status;
      io.err(`${prefix}: ${detail}`);
    }

    if (result.status === 'completed') return EXIT.ok;
    if (result.status === 'refused') return EXIT.refused;
    return EXIT.failed;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    io.err(`failed: ${reason}`);
    return EXIT.failed;
  }
}

/**
 * @param {{ command?: string, positional?: string[], flags: Record<string, string|boolean>, io: { out: (line: string) => void, err: (line: string) => void } }} args
 * @returns {Promise<number>}
 */
export async function delegateCommand({ command, flags, io }) {
  if (command === 'list') return runList(flags, io);
  if (command === 'run') return runDelegate(flags, io);
  io.err(USAGE);
  return EXIT.usage;
}
