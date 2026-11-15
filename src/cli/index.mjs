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
  lain model run <task.json>
  lain model approve <task.json> <model-id>
  lain model reclassify <model-id> <new-effect>
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
import { containerSid, createJobControl } from '../exec/job.mjs';
import { checkExecutionBoundary } from '../exec/boundary.mjs';
import { open as openEventStore } from '../store/index.mjs';
import { isEntryPoint } from '../../tools/check/lib/report.mjs';
import { approveCommand } from './commands/approve.mjs';
import { modelCommand } from './commands/model.mjs';
import { modelApproveCommand } from './commands/model-approve.mjs';
import { modelReclassCommand } from './commands/model-reclass.mjs';

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
      // State the read boundary before anything else happens, and refuse when it
      // cannot be stated. This is the check that keeps "never silently execute an
      // unrestricted child process" a property of the code rather than a sentence
      // in a design document: an unset LAIN_READ_POSTURE stops here, with no task
      // record, no workspace and no tool process.
      const boundary = checkExecutionBoundary({
        workspaceRoot: paths.workspaces,
        stateBase: paths.base,
        env,
      });
      if (!boundary.ok) {
        io.err(`refused: ${boundary.code} — ${boundary.message}`);
        return EXIT.refused;
      }
      if (flags.json) io.err(`read boundary  ${boundary.posture}  ${boundary.code}`);

      // The `kernel` posture is a claim that the tool is confined, so the run has
      // to actually ask for the container. Resolving the SID here rather than
      // deeper keeps the failure at the point where the operator can still be
      // told: without an interpreter the helper cannot derive the SID, and a
      // kernel run that cannot confine anything must refuse rather than proceed
      // to run the tool with the user's own read rights.
      let runContainerSid = null;
      if (boundary.posture === 'kernel') {
        const resolved = containerSid();
        if (!resolved.ok) {
          io.err(`refused: CONTAINER_UNAVAILABLE — ${resolved.detail}`);
          return EXIT.refused;
        }
        runContainerSid = resolved.sid;
        io.err(`container     ${runContainerSid}`);
      }

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
        // Without this the cascade has no way to signal anything: `jobControl` is a
        // port, and until the CLI supplied it the port had no supplier, so a cancel
        // reported `no_job_registered` while the tool kept running. What stopped it
        // was this process exiting and taking the supervisor down with it — the
        // right outcome reached by accident, which is why nobody noticed. With the
        // handle wired, `terminate()` kills the job deliberately and does not
        // return until the supervisor's pid is gone.
        jobControl: createJobControl,
        containerSid: runContainerSid,
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
        // Best effort, and deliberately so: removing the workspace is tidying, and
        // a failure here used to be an uncaught EPERM that killed the process
        // after its JSON had been printed — a partial document on stdout and, for
        // a cancelled run, a report that never mentioned the cancellation. A
        // directory that will not go is worth a line on stderr, not the whole run.
        try {
          rmSync(outcome.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
          // In JSON mode stdout must be exactly one JSON document: a consumer that
          // pipes it into a parser must not have to strip a trailing line. The
          // notice still goes somewhere — stderr — rather than nowhere.
          if (flags.json) io.err(`workspace removed  ${outcome.workspace}`);
          else log(`workspace removed  ${outcome.workspace}`);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          io.err(`workspace kept    ${outcome.workspace}  (${reason})`);
        }
      }
      // A cancelled run is a refusal, not a failure: the tool did not fail, it was
      // stopped, and a caller that treats exit 4 as "your task broke" must not be
      // told that when the answer is "you stopped it". `cancel_failed` is the
      // exception — there the cascade could not prove the tool died, which is a
      // failure and is reported as one.
      if (outcome.state === 'completed') return EXIT.ok;
      if (outcome.state === 'cancelled') return EXIT.refused;
      return EXIT.failed;
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

  if (group === 'model') {
    // `lain model run <file>`, `lain model approve <file> <model-id>` and
    // `lain model reclassify <model-id> <new-effect>` — the M-2/M-3 mock
    // integration, its human-approval gate, and the M-4 authorized override.
    // Each command handler owns its own exit codes and prints exactly one
    // JSON document.
    if (command === 'approve') return modelApproveCommand({ command, positional, flags, io });
    if (command === 'reclassify') return modelReclassCommand({ command, positional, flags, io });
    return modelCommand({ command, positional, flags, io });
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
