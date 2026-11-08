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
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { LainError } from '../core/errors.mjs';

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
 * @param {{workspace: string, temp: string}} args
 */
export function buildEnv({ workspace, temp }) {
  return {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    COMSPEC: process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    TEMP: temp,
    TMP: temp,
    LAIN_WORKSPACE: workspace,
    // Deliberately absent: USERPROFILE, APPDATA, LOCALAPPDATA, HOME,
    // SSH_AUTH_SOCK, AWS_*, GITHUB_TOKEN, and every other variable that could
    // carry a secret into a tool process.
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
 * @param {{root: string, task_id: string, forbidden?: string[], now?: () => number}} options
 * @returns {import('../core/types.mjs').WorkspaceHandle}
 */
export function createWorkspace(options) {
  const root = resolve(options.root);
  const dir = join(root, options.task_id);
  const temp = join(dir, '.tmp');
  const forbidden = options.forbidden ?? [];

  return {
    path: dir,
    temp,

    create() {
      mkdirSync(dir, { recursive: true });
      mkdirSync(temp, { recursive: true });
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
     * Run one process. `child_process` is imported here and nowhere else outside
     * this module, which is what `tools/check/process-boundary.mjs` verifies: a
     * second call site would mean a code path that runs a program without the
     * environment allow-list, the timeout and the output ceiling.
     *
     * @param {{command: string, args?: string[], timeoutMs: number, maxOutputBytes: number, cwd?: string}} spec
     */
    run(spec) {
      const started = Date.now();
      const cwd = spec.cwd ? this.file(spec.cwd) : dir;
      const result = spawnSync(spec.command, spec.args ?? [], {
        cwd,
        env: buildEnv({ workspace: dir, temp }),
        encoding: 'utf8',
        timeout: spec.timeoutMs,
        windowsHide: true,
        shell: false,
        maxBuffer: Math.max(spec.maxOutputBytes * 2, 1_048_576),
      });
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      return {
        status: result.error ? 'error' : result.status === 0 ? 'ok' : 'exit_nonzero',
        exit_code: typeof result.status === 'number' ? result.status : null,
        error_code: result.error ? /** @type {NodeJS.ErrnoException} */ (result.error).code ?? 'SPAWN_FAILED' : null,
        stdout: stdout.slice(0, spec.maxOutputBytes),
        stderr: stderr.slice(0, spec.maxOutputBytes),
        output_truncated: Buffer.byteLength(stdout, 'utf8') > spec.maxOutputBytes,
        duration_ms: Date.now() - started,
        cwd,
      };
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
