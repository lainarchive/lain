/**
 * `run_script` — the one tool the first milestone guarantees.
 *
 * It takes a script the *task author* wrote, writes it into the workspace, runs
 * it with `node`, and returns what happened. It is deliberately the only tool
 * that spawns anything, because that keeps the process boundary auditable: one
 * place creates processes, one place sets their environment, one place enforces
 * the timeout.
 *
 * What it does not do: restrict the network, restrict reads, or interpret the
 * script. A script is code; running it in a directory that is not a sandbox is
 * exactly as safe as that sentence sounds, which is why the capability is
 * explicit and the effect class is `local_reversible` rather than `read_only`.
 */
import { containerEntry, MAX_COMMAND_LINE, windowsCommandLine } from '../exec/job.mjs';
import { ToolError } from './invoke.mjs';

export const RUN_SCRIPT_ID = 'run_script';

/**
 * The script text, from either shape a task file may use.
 *
 * A JSON string needs the whole program on one physical line, which makes a
 * hand-written task file unreadable and pushes it past the repository's line
 * limit. An array of lines is the same program, written the way a person writes
 * one. Accepting both costs four lines here; rejecting the array costs every
 * author who tries it.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function scriptText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((line) => typeof line === 'string')) return value.join('\n');
  return '';
}

/**
 * @param {{workspace: import('../core/types.mjs').WorkspaceHandle}} deps
 * @returns {import('../tools/registry.mjs').ToolDefinition}
 */
export function createRunScriptTool({ workspace }) {
  return {
    tool_id: RUN_SCRIPT_ID,
    summary: 'Write a Node script into the workspace and run it, returning exit code, output and artifacts.',
    requires: ['workspace.write', 'process.spawn'],
    effect_class: 'local_reversible',
    spawns_processes: true,

    /**
     * @param {Record<string, unknown>} args
     * @param {import('./registry.mjs').RunContext} ctx
     */
    run(args, ctx) {
      const script = scriptText(args?.script);
      if (script.trim().length === 0) throw new ToolError('SCRIPT_EMPTY', 'run_script requires a non-empty script (a string, or an array of lines)');
      const name = typeof args?.name === 'string' && args.name.length > 0 ? args.name : 'task-script.mjs';

      const decision = workspace.resolve(name);
      if (!decision.ok || !decision.path) throw new ToolError(decision.code ?? 'INVALID_PATH', 'the script path is outside the workspace', decision.detail);

      // Inside the container the program cannot be handed over as a file: node
      // resolves the main module to canonical form, that walk reaches the volume
      // root, and `lstat 'C:\'` is denied - so a granted script still dies with
      // EPERM -4048. It goes on the command line instead, which is why the
      // length is checked here, before anything is written. The argument list is
      // the same in both worlds on purpose: process.argv[1] is the script and
      // process.argv[2] is the workspace, so an author does not have to know
      // which one they are in.
      const entry = containerEntry({ container: workspace.container });
      const argv = entry.node_entry === 'eval'
        ? ['-e', script, decision.path, workspace.path]
        : [decision.path, workspace.path];

      if (entry.node_entry === 'eval') {
        const length = windowsCommandLine([process.execPath, ...argv]).length;
        if (length > MAX_COMMAND_LINE) {
          throw new ToolError('SCRIPT_TOO_LONG',
            `this script needs ${length} characters of command line and the limit is ${MAX_COMMAND_LINE}; `
            + 'nothing was written and nothing ran');
        }
      }

      const written = workspace.write(name, script);
      const timeoutMs = Math.min(
        typeof args?.timeout_ms === 'number' ? args.timeout_ms : ctx.budget.max_wall_ms,
        ctx.budget.max_wall_ms,
      );

      return workspace.runAsync({
        command: process.execPath,
        args: argv,
        timeoutMs,
        maxOutputBytes: ctx.budget.max_output_bytes,
        cwd: '.',
      }).then((run) => {
        const artifacts = workspace.contents().map((entry2) => ({ path: entry2.path, bytes: entry2.bytes }));
        return {
          status: run.status === 'error' ? 'error' : 'ok',
          script_path: written.path,
          exit_code: run.exit_code,
          stdout: run.stdout,
          stderr: run.stderr,
          output_truncated: run.output_truncated,
          duration_ms: run.duration_ms,
          artifacts,
          // Carried through so a refused boundary and a refused ceiling land in
          // the same field the caller already reads.
          pid: run.pid,
          killed_by: run.killed_by,
          limits_applied: run.limits_applied,
          limits_refused: run.limits_refused,
        };
      });
    },
  };
}
