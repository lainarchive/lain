#!/usr/bin/env node
/**
 * `lain` — the command line for the first execurable milestone.
 *
 * Four commands, deliberately: run one task, look at one task, verify the log,
 * answer one approval question. There is no REPL and no model call; `lain
 * approve` is the only command that reads stdin, and only to answer a question it
 * has just displayed.
 *
 *   lain task run --task <file.json> [--allow <tool_id>] [--by <flag_source>] [--cancel-after <ms>]
 *                 [--keep-workspace] [--json]
 *   lain task show <task_id> [--json]
 *   lain store verify [--json]
 *   lain approve <approval_id> [--list] [--answer granted|denied --by <name> --digest <hex>] [--json]
 */
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateTaskDraft } from '../tasks/contract.mjs';
import { openTaskStore } from '../tasks/store.mjs';
import { DEFAULT_RULES } from '../policy/rules.mjs';
import { createRegistry } from '../tools/registry.mjs';
import { createRunScriptTool } from '../tools/run-script.mjs';
import { contractFromJson, createTaskRunner } from '../agent/task-runner.mjs';
import { open as openEventStore } from '../store/index.mjs';
import { isEntryPoint } from '../../tools/check/lib/report.mjs';
import { approveCommand } from './commands/approve.mjs';

export const EXIT = { ok: 0, usage: 2, refused: 3, failed: 4 };

/**
 * Where Lain keeps state. Under the user's local app data rather than the
 * repository, so a task cannot reach its own log by relative path.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function statePaths(env = process.env) {
  const base = env.LAIN_HOME ?? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Lain');
  return {
    base,
    log: join(base, 'events.db'),
    tasks: join(base, 'tasks.db'),
    workspaces: join(base, 'workspaces'),
    approvals: join(base, 'approvals.json'),
  };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const [group, second, ...tail] = argv;
  // The second token is a command only when it reads as one: `lain approve --list`
  // is a group followed by a flag, not a two-word command called "--list".
  const command = second !== undefined && !second.startsWith('--') ? second : undefined;
  const rest = command === undefined ? argv.slice(1) : tail;
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === undefined) continue;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else positional.push(token);
  }
  return { group, command, flags, positional };
}

const USAGE = `lain — one bounded, authorized task

  lain task run --task <file.json> [--allow <tool_id>] [--by <flag_source>] [--cancel-after <ms>]
                [--keep-workspace] [--json]
  lain task show <task_id> [--json]
  lain store verify [--json]
  lain approve <approval_id> [--json]
  lain approve --list [--json]
  lain approve <approval_id> --answer granted|denied --by <name> --digest <hex> [--json]
  lain approve <approval_id> --allow [--json]
`;

/** @param {string} path */
export function loadTaskFile(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    raw,
    contract: contractFromJson(raw),
    tool_id: String(raw.tool_id ?? 'run_script'),
    tool_arguments: raw.tool_arguments ?? {},
  };
}

export async function main(argv = process.argv.slice(2), io = { out: console.log, err: console.error }, env = process.env) {
  const { group, command, flags, positional } = parseArgs(argv);
  const paths = statePaths(env);
  const log = io.out;

  if (group === 'task' && command === 'run') {
    if (typeof flags.task !== 'string') {
      io.err(USAGE);
      return EXIT.usage;
    }
    const file = loadTaskFile(resolve(flags.task));

    let contract;
    try {
      contract = validateTaskDraft(file.contract);
    } catch (err) {
      const e = /** @type {Error & {code?: string}} */ (err);
      io.err(`refused: ${e.code ?? 'INVALID_TASK'} — ${e.message}`);
      return EXIT.refused;
    }

    const events = openEventStore({ path: paths.log, producer: 'cli' });
    const taskStore = openTaskStore({ path: paths.tasks });
    try {
      // `--cancel-after <ms>` asks for a stop that long after execution starts.
      // Validated here rather than passed through, because a typo like
      // `--cancel-after soon` must not quietly become "no cancellation" — a run
      // that looks like it honoured a limit it never received is worse than one
      // that refuses the flag. Parsed strictly: digits only, positive, finite.
      //
      // Measured once the tool runner went asynchronous: a 3 s blocking script
      // under `--cancel-after 200` is stopped in 591 ms and settles `cancelled`,
      // against 3996 ms and `completed` before. The run reports
      // `invocation: null`, because a cancellation that wins the race means
      // there is no invocation result to report — the absence is the finding,
      // not a missing field. The workspace is removed as usual: what the tool
      // wrote before it was stopped is still in the log.
      let cancelAfter;
      if (flags['cancel-after'] !== undefined) {
        const raw = flags['cancel-after'];
        const ms = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
        if (!Number.isFinite(ms) || ms <= 0) {
          io.err(`usage: --cancel-after takes a positive whole number of milliseconds, not ${String(raw)}`);
          return EXIT.usage;
        }
        cancelAfter = ms;
      }

      const registry = createRegistry({ rules: DEFAULT_RULES });
      const runner = createTaskRunner({
        taskStore,
        openLog: () => events,
        registry,
        rules: DEFAULT_RULES,
        workspaceRoot: paths.workspaces,
        makeTool: (workspace) => createRunScriptTool({ workspace }),
        // A `--allow` grant is recorded in the ledger like any other approval, so
        // the run leaves behind what it was granted and who granted it — a flag,
        // not a person. `path` is what makes the record outlive the process.
        approvals: flags.allow
          ? { allow: [String(flags.allow)], by: flags.by ? String(flags.by) : null, path: paths.approvals }
          : {},
      });

      const outcome = await runner.run({
        contract,
        tool_id: file.tool_id,
        tool_arguments: file.tool_arguments,
        ...(cancelAfter === undefined ? {} : { cancel_after_ms: cancelAfter }),
      });

      if (flags.json) log(JSON.stringify(outcome, null, 2));
      else printOutcome(log, outcome);

      if (!flags['keep-workspace'] && outcome.workspace) {
        rmSync(outcome.workspace, { recursive: true, force: true });
        // In JSON mode stdout must be exactly one JSON document: a consumer that
        // pipes it into a parser must not have to strip a trailing line. The
        // notice still goes somewhere — stderr — rather than nowhere.
        if (flags.json) io.err(`workspace removed  ${outcome.workspace}`);
        else log(`workspace removed  ${outcome.workspace}`);
      }
      return outcome.state === 'completed' ? EXIT.ok : EXIT.failed;
    } finally {
      taskStore.close();
      events.close();
    }
  }

  if (group === 'task' && command === 'show') {
    const taskId = positional[0];
    if (!taskId) {
      io.err(USAGE);
      return EXIT.usage;
    }
    const taskStore = openTaskStore({ path: paths.tasks });
    try {
      const task = taskStore.get(taskId);
      const history = taskStore.history(taskId);
      const verification = taskStore.verify(taskId);
      if (flags.json) log(JSON.stringify({ task, history, verification }, null, 2));
      else {
        log(`task       ${task.task_id}`);
        log(`state      ${task.state}`);
        log(`objective  ${task.objective}`);
        log('history:');
        for (const row of history) log(`  ${row.seq}. ${row.from} → ${row.to}${row.reason ? `  (${row.reason})` : ''}`);
        log(`verified   ${verification.ok ? 'yes' : `no — ${verification.findings.map((f) => f.code).join(', ')}`}`);
      }
      return verification.ok ? EXIT.ok : EXIT.failed;
    } finally {
      taskStore.close();
    }
  }

  if (group === 'store' && command === 'verify') {
    const events = openEventStore({ path: paths.log, producer: 'cli' });
    try {
      const report = events.verify({ deep: true });
      const stats = events.stats();
      if (flags.json) log(JSON.stringify({ stats, report }, null, 2));
      else {
        log(`events  ${stats.count}`);
        log(`schema  ${stats.schema_version}`);
        for (const check of report.checks) log(`${check.ok ? 'ok  ' : 'FAIL'}    ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
      }
      return report.checks.every((/** @type {{ok: boolean}} */ c) => c.ok) ? EXIT.ok : EXIT.failed;
    } finally {
      events.close();
    }
  }

  if (group === 'approve') {
    // `lain approve <id>` is one word plus an id, so the id arrives in the
    // "command" token: parseArgs is shaped for two-word commands, and this is the
    // one command whose verb is a single word.
    return approveCommand({
      positional: command ? [command, ...positional] : positional,
      flags,
      io,
      approvalsPath: paths.approvals,
    });
  }

  io.err(USAGE);
  return EXIT.usage;
}

/** @param {(line: string) => void} log @param {import('../core/types.mjs').RunnerOutcome} outcome */
export function printOutcome(log, outcome) {
  log(`task       ${outcome.task_id}`);
  log(`state      ${outcome.state}`);
  if (outcome.admission) log(`admission  ${outcome.admission.outcome} (${outcome.admission.arm_id}: ${outcome.admission.reason_code})`);
  const result = outcome.result;
  if (!result) {
    log('no result was recorded');
    return;
  }
  log(`tool       ${result.tool.tool_id} → ${result.tool.status}${result.tool.reason_code ? ` (${result.tool.reason_code})` : ''}`);
  for (const check of result.checks) {
    log(`check      ${check.required ? '[required]' : '[optional]'} ${check.id}: ${check.verdict} — ${check.detail}`);
  }
  for (const entry of result.artifacts) log(`artifact   ${entry.path} (${entry.bytes} B)`);
  for (const entry of result.not_verified) log(`unverified ${entry.id} — ${entry.detail}`);
  for (const entry of result.indeterminate) log(`indeterm.  ${entry.what} — ${entry.why}`);
}

if (isEntryPoint(import.meta.url)) {
  process.exit(await main());
}
