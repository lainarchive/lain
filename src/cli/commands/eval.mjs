// `lain eval <register|run|compare|rollback|list>` — Phase 7 evaluation harness CLI
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EVAL_STATUSES, openExperimentRegistry } from '../../eval/harness.mjs';

/** Kept equal to `EXIT` in `../index.mjs` to avoid circular imports. */
const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

const VALID_STATUSES = new Set(EVAL_STATUSES);
const REFUSED_CODES = new Set([
  'EXPERIMENT_ROLLED_BACK',
  'ALREADY_ROLLED_BACK',
  'EXPERIMENT_EXISTS',
]);

const USAGE = `lain eval — register, run, compare, and roll back model experiments

  lain eval register --name <n> --candidate <m> --baseline <m> --source <s> [--id <id>] [--lain-home <dir>] [--json]
  lain eval run <experiment_id> --model <m> --tasks <file.json> [--lain-home <dir>] [--json]
  lain eval compare <experiment_id> [--lain-home <dir>] [--json]
  lain eval rollback <experiment_id> --by <who> [--reason <r>] [--lain-home <dir>] [--json]
  lain eval list [--status active|rolled_back] [--lain-home <dir>] [--json]
`;

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * @param {Record<string, string|boolean>} flags
 * @param {string} key
 * @returns {string | undefined}
 */
function stringFlag(flags, key) {
  return nonEmpty(flags[key]);
}

/**
 * @param {Record<string, string|boolean>} flags
 * @param {string | undefined} dbPath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
function resolveDbPath(flags, dbPath, env = process.env) {
  if (typeof dbPath === 'string' && dbPath.trim() !== '') return dbPath;
  if (flags['lain-home'] === true) return null;
  if (typeof flags['lain-home'] === 'string' && flags['lain-home'].trim() === '') return null;
  const home = stringFlag(flags, 'lain-home') || env.LAIN_HOME || join(homedir(), '.lain');
  return join(home, 'eval.db');
}

/**
 * @param {{ out: (line: string) => void, err: (line: string) => void }} io
 * @param {unknown} err
 * @returns {number}
 */
function handleEvalError(io, err) {
  const e = /** @type {Error & { code?: string }} */ (err);
  const code = typeof e?.code === 'string' ? e.code : '';
  const message = e instanceof Error ? e.message : String(err);
  if (REFUSED_CODES.has(code)) {
    io.err(`refused: ${code} — ${message}`);
    return EXIT.refused;
  }
  const prefix = code ? `${code} — ` : '';
  io.err(`failed: ${prefix}${message}`);
  return EXIT.failed;
}

/**
 * @param {string} targetPath
 * @param {{ out: (line: string) => void, err: (line: string) => void }} io
 * @param {(reg: ReturnType<typeof openExperimentRegistry>) => Promise<number> | number} fn
 * @returns {Promise<number>}
 */
async function withRegistry(targetPath, io, fn) {
  /** @type {ReturnType<typeof openExperimentRegistry> | undefined} */
  let reg;
  try {
    reg = openExperimentRegistry({ path: targetPath });
    return await fn(reg);
  } catch (err) {
    return handleEvalError(io, err);
  } finally {
    reg?.close();
  }
}

/**
 * @param {string | undefined} tasksPath
 * @param {{ out: (line: string) => void, err: (line: string) => void }} io
 * @returns {{ ok: true, tasks: Array<{ id: string, objective: string, expected_substring?: string }> } | { ok: false, code: number }}
 */
function readTasksFile(tasksPath, io) {
  if (!tasksPath) {
    io.err(USAGE);
    return { ok: false, code: EXIT.usage };
  }
  try {
    const raw = JSON.parse(readFileSync(tasksPath, 'utf8'));
    if (!Array.isArray(raw) || raw.length === 0) {
      io.err('usage: --tasks must be a non-empty JSON array');
      return { ok: false, code: EXIT.usage };
    }
    for (const item of raw) {
      if (!item || typeof item !== 'object' || !nonEmpty(item.id) || !nonEmpty(item.objective)) {
        io.err('usage: each task must have non-empty string id and objective');
        return { ok: false, code: EXIT.usage };
      }
    }
    return { ok: true, tasks: raw };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    io.err(`usage: cannot read tasks file — ${reason}`);
    return { ok: false, code: EXIT.usage };
  }
}

/**
 * @param {{
 *   command?: string,
 *   positional?: string[],
 *   flags: Record<string, string|boolean>,
 *   io: { out: (line: string) => void, err: (line: string) => void },
 *   dbPath?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} args
 * @returns {Promise<number>}
 */
export async function evalCommand({ command, positional = [], flags, io, dbPath, env = process.env }) {
  const asJson = Boolean(flags.json);
  const targetPath = resolveDbPath(flags, dbPath, env);
  if (targetPath === null) {
    io.err(USAGE);
    return EXIT.usage;
  }

  if (command === 'register') {
    const name = stringFlag(flags, 'name');
    const candidateModel = stringFlag(flags, 'candidate');
    const baselineModel = stringFlag(flags, 'baseline');
    const source = stringFlag(flags, 'source');
    if (flags.id === true || (typeof flags.id === 'string' && flags.id.trim() === '')) {
      io.err(USAGE);
      return EXIT.usage;
    }
    const id = stringFlag(flags, 'id');
    if (!name || !candidateModel || !baselineModel || !source) {
      io.err(USAGE);
      return EXIT.usage;
    }

    return withRegistry(targetPath, io, (reg) => {
      const record = reg.registerExperiment({ id, name, candidateModel, baselineModel, source });
      if (asJson) io.out(JSON.stringify(record, null, 2));
      else io.out(`registered ${record.id} name=${record.name} status=${record.status} candidate=${record.candidate_model} baseline=${record.baseline_model}`);
      return EXIT.ok;
    });
  }

  if (command === 'run') {
    const experimentId = nonEmpty(positional[0]);
    const modelId = stringFlag(flags, 'model');
    const tasksPath = stringFlag(flags, 'tasks');
    if (!experimentId || !modelId || !tasksPath) {
      io.err(USAGE);
      return EXIT.usage;
    }
    const loaded = readTasksFile(tasksPath, io);
    if (!loaded.ok) return loaded.code;

    return withRegistry(targetPath, io, async (reg) => {
      const summary = await reg.runEvalSuite({ experimentId, modelId, tasks: loaded.tasks });
      if (asJson) io.out(JSON.stringify(summary, null, 2));
      else {
        io.out(
          `eval ${summary.experiment_id} model=${summary.model_id} passed=${summary.passed}/${summary.total}` +
            ` pass_rate=${summary.pass_rate} avg_latency_ms=${summary.avg_latency_ms} total_cost=${summary.total_cost}`,
        );
      }
      return EXIT.ok;
    });
  }

  if (command === 'compare') {
    const experimentId = nonEmpty(positional[0]);
    if (!experimentId) {
      io.err(USAGE);
      return EXIT.usage;
    }

    return withRegistry(targetPath, io, (reg) => {
      const report = reg.compareCandidates(experimentId);
      if (asJson) {
        io.out(JSON.stringify(report, null, 2));
      } else {
        io.out(`experiment      ${report.experiment_id}`);
        io.out(`recommendation  ${report.recommendation}`);
        io.out(`baseline        ${report.baseline.model_id} pass_rate=${report.baseline.pass_rate} total=${report.baseline.total} avg_latency_ms=${report.baseline.avg_latency_ms}`);
        io.out(`candidate       ${report.candidate.model_id} pass_rate=${report.candidate.pass_rate} total=${report.candidate.total} avg_latency_ms=${report.candidate.avg_latency_ms}`);
      }
      return EXIT.ok;
    });
  }

  if (command === 'rollback') {
    const experimentId = nonEmpty(positional[0]);
    const by = stringFlag(flags, 'by');
    if (!experimentId || !by || flags.reason === true) {
      io.err(USAGE);
      return EXIT.usage;
    }
    const reason = typeof flags.reason === 'string' ? flags.reason : '';

    return withRegistry(targetPath, io, (reg) => {
      const record = reg.rollbackExperiment(experimentId, { rolledBackBy: by, reason });
      if (asJson) io.out(JSON.stringify(record, null, 2));
      else io.out(`rolled_back ${record.id} by=${record.rolled_back_by} status=${record.status}`);
      return EXIT.ok;
    });
  }

  if (command === 'list') {
    /** @type {'active' | 'rolled_back' | undefined} */
    let status;
    if (flags.status !== undefined) {
      if (typeof flags.status !== 'string' || !VALID_STATUSES.has(flags.status)) {
        io.err(USAGE);
        return EXIT.usage;
      }
      status = /** @type {'active' | 'rolled_back'} */ (flags.status);
    }

    return withRegistry(targetPath, io, (reg) => {
      const rows = reg.list(status ? { status } : {});
      if (asJson) {
        io.out(JSON.stringify(rows, null, 2));
      } else if (rows.length === 0) {
        io.out('no experiments found');
      } else {
        for (const r of rows) {
          io.out(`${r.id}  [${r.status}] ${r.name} (${r.candidate_model} vs ${r.baseline_model}) — ${r.source}`);
        }
      }
      return EXIT.ok;
    });
  }

  io.err(USAGE);
  return EXIT.usage;
}
