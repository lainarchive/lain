/**
 * The contained workspace.
 *
 * What this is: a directory that belongs to one task, whose process runs with a
 * redirected environment so that temporary files land inside it, and a scrub
 * that refuses any declared write that resolves outside it.
 *
 * What this is **not**: a sandbox. Path checking is defeatable (Phase 0's E5
 * experiment contained 9 of 11 redirect classes and could not test 2 of them),
 * reads are unrestricted, and this module does not restrict the network. The
 * honest sentence ends "Lain is not a sandbox" and nothing here changes that.
 *
 * The scrub exists to stop *careless* writes, and it is written so that a
 * refusal is a recorded outcome rather than an exception nobody sees.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { LainError } from '../core/errors.mjs';
import { containerSid, runInJob, runInJobSync } from './job.mjs';

export class WorkspaceError extends LainError {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, message, detail = {}) {
    super(code, message, detail);
    this.name = 'WorkspaceError';
  }
}

/** The capabilities a script needs before the workspace will run it. */
export const SCRIPT_CAPABILITIES = ['workspace.write', 'process.spawn'];

/**
 * Environment allow-list. The child gets *these* variables and nothing else —
 * an inherited environment would hand the tool every credential the user's shell
 * happens to hold, which is exactly what the threat model says must not happen.
 *
 * LOCALAPPDATA is the one exception, and only for a containerised run. An
 * AppContainer cannot be created from an environment block that lacks it:
 * `CreateProcessW` comes back ERROR_ENVVAR_NOT_FOUND (203) with the rest of this
 * list present and correct. Measured 2026-11-08 — the same list plus
 * LOCALAPPDATA starts, the same list alone does not. The system appends
 * `\Packages\<profile>\AC` to whatever base is given, so the base here is a
 * directory inside the workspace the container already owns, and the real
 * profile path never reaches the tool.
 *
 * @param {{workspace: string, temp: string, container?: boolean}} args
 */
export function buildEnv({ workspace, temp, container = false }) {
  return {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    COMSPEC: process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    TEMP: temp,
    TMP: temp,
    LAIN_WORKSPACE: workspace,
    // Deliberately absent: USERPROFILE, APPDATA, HOME, SSH_AUTH_SOCK, AWS_*,
    // GITHUB_TOKEN, and every other variable that could carry a secret into a
    // tool process.
    ...(container ? { LOCALAPPDATA: join(workspace, '.localappdata') } : {}),
  };
}

/**
 * Refuse a path that leaves the workspace. Returns a decision object instead of
 * throwing so the caller can record the refusal as an event — a refused write is
 * information, not an error to swallow.
 *
 * @param {string} workspace
 * @param {string} candidate
 * @param {{forbidden?: string[]}} [opts]
 */
export function scrubPath(workspace, candidate, opts = {}) {
  const root = resolve(workspace);
  const raw = String(candidate ?? '');
  if (raw.length === 0) return { ok: false, code: 'EMPTY_PATH', detail: {} };

  // Reject the Windows redirects before resolution: `\\?\` and `\\.\` do not go
  // through the normalising path functions, and one of the two untestable E5
  // classes is exactly this family.
  if (/^\\\\[.?]\\/.test(raw)) return { ok: false, code: 'DEVICE_PATH', detail: { path: raw } };

  const target = resolve(isAbsolute(raw) ? raw : join(root, raw));
  const rel = relative(root, target);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    return { ok: false, code: 'OUTSIDE_WORKSPACE', detail: { path: target, workspace: root } };
  }
  for (const forbidden of opts.forbidden ?? []) {
    if (normalize(target).toLowerCase().includes(forbidden.toLowerCase())) {
      return { ok: false, code: 'FORBIDDEN_PATH', detail: { path: target, rule: forbidden } };
    }
  }
  return { ok: true, path: target };
}

/**
 * A workspace handle for one task.
 *
 * `helperPath` and `python` exist so a test can describe a broken machine - a
 * missing supervisor, a missing interpreter - without breaking this one. They
 * are how the fail-closed path is exercised rather than assumed.
 *
 * `container` names the AppContainer every run from this workspace is launched
 * into. Absent means the older shape: a job object with no read boundary.
 *
 * @param {{root: string, task_id: string, forbidden?: string[], now?: () => number,
 *   helperPath?: string, python?: string, container?: string}} options
 * @returns {import('../core/types.mjs').WorkspaceHandle}
 */
export function createWorkspace(options) {
  const root = resolve(options.root);
  const dir = join(root, options.task_id);
  const temp = join(dir, '.tmp');
  const forbidden = options.forbidden ?? [];

  /** @param {Record<string, any>} spec @param {string} cwd */
  const jobSpec = (spec, cwd) => ({
    command: spec.command,
    args: spec.args ?? [],
    cwd,
    outputBytes: spec.maxOutputBytes,
    supervisorMs: spec.timeoutMs,
    env: buildEnv({ workspace: dir, temp, container: Boolean(options.container) }),
    limits: { job_ms: spec.timeoutMs },
    // Registered against this, so the cancel path can find the supervisor
    // while the tool is still running.
    task_id: options.task_id,
    helperPath: options.helperPath,
    python: options.python,
    container: options.container,
  });

  /** @param {Record<string, any>} spec @param {string} cwd @param {Record<string, any>} result */
  const shape = (spec, cwd, result) => {
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    return {
      status: result.status === 'ok' ? 'ok'
        : result.status === 'exit_nonzero' ? 'exit_nonzero' : 'error',
      exit_code: result.exit_code,
      error_code: result.error_code,
      stdout: stdout.slice(0, spec.maxOutputBytes),
      stderr: stderr.slice(0, spec.maxOutputBytes),
      output_truncated: result.output_truncated
        || Buffer.byteLength(stdout, 'utf8') > spec.maxOutputBytes,
      duration_ms: result.duration_ms,
      cwd,
      pid: result.pid,
      limits_applied: result.limits_applied,
      limits_refused: result.limits_refused,
      killed_by: result.killed_by,
      kill_reason: result.kill_reason,
      job_name: result.job_name,
      helper_sha256: result.helper_sha256,
    };
  };

  return {
    path: dir,
    temp,

    create() {
      mkdirSync(dir, { recursive: true });
      mkdirSync(temp, { recursive: true });
      if (options.container) {
        const sid = containerSid();
        if (!sid.ok) {
          throw new WorkspaceError('CONTAINER_UNAVAILABLE',
            'the workspace cannot be granted to the container, so no tool may run in it', { detail: sid.detail });
        }
        // Modify, not Full: (OI)(CI)M is narrower than F and carries neither
        // WRITE_DAC nor WRITE_OWNER, so the tool cannot rewrite the very ACL
        // that confines it. It is still enough to create, append, rename and
        // delete inside its own workspace, which is what ordinary work needs -
        // a boundary that breaks that is a boundary someone gets told to turn
        // off. Granted on this one task directory, never on a shared parent.
        const grant = spawnSync('icacls', [dir, '/grant', `*${sid.sid}:(OI)(CI)M`],
          { encoding: 'utf8', windowsHide: true });
        if (grant.status !== 0) {
          throw new WorkspaceError('CONTAINER_GRANT_FAILED',
            `icacls could not grant ${sid.sid} on the workspace`,
            { detail: (grant.stderr ?? '').trim() || `icacls exited ${grant.status}` });
        }
      }
      return dir;
    },

    /**
     * Resolve a path inside the workspace, or refuse it.
     * @param {string} relativePath
     */
    resolve(relativePath) {
      return scrubPath(dir, relativePath, { forbidden });
    },

    /** @param {string} relativePath */
    file(relativePath) {
      const decision = scrubPath(dir, relativePath, { forbidden });
      if (!decision.ok || !decision.path) throw new WorkspaceError(decision.code ?? 'INVALID_PATH', 'refusing path outside the workspace', decision.detail);
      return decision.path;
    },

    /** @param {string} relativePath @param {string} contents */
    write(relativePath, contents) {
      const decision = scrubPath(dir, relativePath, { forbidden });
      if (!decision.ok || !decision.path) throw new WorkspaceError(decision.code ?? 'INVALID_PATH', 'refusing to write outside the workspace', decision.detail);
      const target = decision.path;
      // A filesystem failure is translated, not leaked. An `EEXIST` escaping as
      // a bare Error means a caller whose job is to report "the tool could not
      // write" instead has to catch an unnamed error to find that out — and the
      // caller that does not is the one that reports success.
      try {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents, 'utf8');
      } catch (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code ?? 'WRITE_FAILED';
        throw new WorkspaceError(
          code === 'EEXIST' ? 'PATH_OCCUPIED' : 'WRITE_FAILED',
          `could not write ${relativePath} inside the workspace`,
          { code, path: target, cause: err instanceof Error ? err.message : String(err) },
        );
      }
      return { path: target, bytes: Buffer.byteLength(contents, 'utf8') };
    },

    /**
     * The AppContainer this workspace's runs are launched into, or null. A tool
     * reads this rather than guessing, because inside a container a script has
     * to be handed over `-e` - see containerEntry() in ./job.mjs, which is the
     * one place that decides it.
     */
    container: options.container ?? null,

    /**
     * Run one process inside a Windows job object, through src/exec/job.mjs and
     * tools/win32/job_host.py.
     *
     * `timeoutMs` is applied twice on purpose: as the job's CPU-time ceiling and
     * as the supervisor's wall clock. The job ceiling alone would not bound a
     * tool that sleeps, because it is charged in user-mode CPU time.
     *
     * A run whose ceilings could not be applied comes back as `error` with
     * `limits_refused` filled in, and is never retried without them: falling
     * back to unenforced execution is the one outcome this seam exists to
     * prevent.
     *
     * @param {{command: string, args?: string[], timeoutMs: number, maxOutputBytes: number, cwd?: string}} spec
     */
    run(spec) {
      const cwd = spec.cwd ? this.file(spec.cwd) : dir;
      return shape(spec, cwd, runInJobSync(jobSpec(spec, cwd)));
    },

    /**
     * The same run without holding the event loop, which is what a cancellable
     * tool needs: while the promise is pending the supervisor pid is published,
     * so `--cancel-after` has something to kill. The synchronous face cannot
     * offer that - by the time spawnSync returns, the run is already over.
     *
     * @param {{command: string, args?: string[], timeoutMs: number, maxOutputBytes: number, cwd?: string}} spec
     */
    async runAsync(spec) {
      const cwd = spec.cwd ? this.file(spec.cwd) : dir;
      return shape(spec, cwd, await runInJob(jobSpec(spec, cwd)));
    },

    /** Everything created inside the workspace, by relative path. */
    contents() {
      /** @type {{path: string, bytes: number}[]} */
      const out = [];
      /** @param {string} current */
      const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const full = join(current, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.push({ path: relative(dir, full).split(sep).join('/'), bytes: statSync(full).size });
        }
      };
      if (existsSync(dir)) walk(dir);
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },

    destroy() {
      rmSync(dir, { recursive: true, force: true });
      return { removed: dir, exists: existsSync(dir) };
    },
  };
}
