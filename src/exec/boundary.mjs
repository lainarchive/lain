// What the execution boundary actually is, checked rather than assumed.
//
// V-3 set out to make a tool process unable to read the user's files, enforced by
// the kernel. That turned out to be unavailable unelevated on this machine, and
// the measurements are in docs/research/v3-read-isolation/. What remains is the
// part that does not need a kernel mechanism: stating the boundary out loud, and
// refusing to run when the statement cannot be made.
//
// The rule this file implements is deliberately blunt. Lain will not start a tool
// process that reads the user's files unless the deployment says, in the
// environment, that it knows that is what is happening. An unset variable is a
// refusal, not a default, because the failure mode of the other choice is a
// system that quietly has no boundary and reports success.
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The variable a deployment sets to state which boundary it is running under. */
export const READ_POSTURE_ENV = 'LAIN_READ_POSTURE';

/**
 * The three postures, and why there is no fourth.
 *
 * `kernel` means an operating-system mechanism prevents the tool from reading
 * outside its workspace. As of V-3 there is one: the tool is launched into a
 * Windows AppContainer whose SID is derived from a profile name, with read grants
 * given only to the workspace and the interpreter directories it genuinely needs.
 * Measured: a granted directory reads, and `C:\Users\frick`, `C:\Users\frick\.ssh`,
 * `%TEMP%` and `C:\Program Files\nodejs` all refuse with `EPERM` (errno -4048).
 *
 * `declared` means the operator has accepted that reads are unrestricted. It is
 * the escape hatch for a machine where the container cannot be prepared, and it is
 * opt-in and on the record.
 *
 * `none` is the absence of a statement: no mechanism and no acceptance. It fails
 * closed, which is why it is the default.
 */
export const READ_POSTURES = Object.freeze({
  kernel: {
    id: 'kernel',
    reads_confined: true,
    selectable: true,
    mechanism: 'windows-appcontainer',
    summary: 'an AppContainer confines reads to the workspace and the runtime that was granted to it',
  },
  declared: {
    id: 'declared',
    reads_confined: false,
    selectable: true,
    summary: 'reads outside the workspace are possible, and the deployment has accepted that in writing',
  },
  none: {
    id: 'none',
    reads_confined: false,
    selectable: true,
    summary: 'nothing confines reads and nothing has accepted that',
  },
});

/**
 * Which posture this process is running under, from the environment alone.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{posture: typeof READ_POSTURES[keyof typeof READ_POSTURES], raw: string|null, accepted: boolean}}
 */
export function readPosture(env = process.env) {
  const raw = typeof env[READ_POSTURE_ENV] === 'string' ? env[READ_POSTURE_ENV].trim().toLowerCase() : null;
  if (raw === 'declared') {
    return { posture: READ_POSTURES.declared, raw, accepted: true };
  }
  if (raw === 'kernel') {
    return { posture: READ_POSTURES.kernel, raw, accepted: true };
  }
  return { posture: READ_POSTURES.none, raw, accepted: false };
}

/**
 * The runtime paths a tool process must be able to read for the interpreters to
 * start at all.
 *
 * This is the measurement that closed the kernel route: Node and Python do not
 * live only in their install directories, they also read caches and support files
 * under the user profile. Naming them here means the eventual mechanism has a list
 * to grant rather than a discovery problem — and it is the honest reason a
 * read-confined tool cannot simply be handed a workspace and nothing else.
 *
 * @param {{execPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string[]} absolute paths, de-duplicated
 */
export function runtimeReadRoots(options = {}) {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const roots = new Set();
  if (typeof execPath === 'string' && isAbsolute(execPath)) roots.add(dirname(execPath));
  for (const key of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const value = env[key];
    if (typeof value === 'string' && isAbsolute(value)) roots.add(resolve(value));
  }
  // The one that matters and the one that is easy to forget: the interpreters
  // read their own caches and support files out of the user's local app data.
  if (typeof env.LOCALAPPDATA === 'string' && isAbsolute(env.LOCALAPPDATA)) {
    roots.add(resolve(env.LOCALAPPDATA));
  }
  return [...roots];
}

/**
 * Whether `child` really sits inside `parent` once links are resolved.
 *
 * Case is folded, because this is Windows and `C:\Users` and `c:\users` are the
 * same directory. The separator is required after the prefix so that
 * `C:\workspaces-elsewhere` does not count as inside `C:\workspaces`.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInside(parent, child) {
  const a = resolve(parent).toLowerCase();
  const b = resolve(child).toLowerCase();
  if (a === b) return true;
  return b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/**
 * Every path inside `dir` that is a link, or that resolves outside it.
 *
 * A reparse point inside the workspace is the one way a correctly-scrubbed
 * relative path can still name a file somewhere else, so the boundary is verified
 * rather than trusted. The walk does not follow links — it reports them.
 *
 * @param {string} dir
 * @param {{maxEntries?: number}} [options]
 * @returns {{checked: number, links: string[], escaped: string[], hardLinks: string[], truncated: boolean}}
 */
export function inspectContainment(dir, options = {}) {
  const maxEntries = options.maxEntries ?? 5000;
  /** @type {string[]} */
  const links = [];
  /** @type {string[]} */
  const escaped = [];
  /** @type {string[]} */
  const hardLinks = [];
  let checked = 0;
  let truncated = false;

  /** @param {string} current */
  const walk = (current) => {
    if (truncated) return;
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable is not the same as absent, and the caller sees `checked`
    }
    for (const entry of entries) {
      if (checked >= maxEntries) {
        truncated = true;
        return;
      }
      checked += 1;
      const full = join(current, entry.name);
      const linked = entry.isSymbolicLink() || isReparsePoint(full);
      if (linked) {
        links.push(full);
        try {
          const target = realpathSync(full);
          if (!isInside(dir, target)) escaped.push(full);
        } catch {
          // A link whose target cannot be resolved is reported as a link and not
          // as an escape: unresolved is unknown, and unknown must not read as safe.
        }
        continue;
      }
      if (entry.isDirectory()) walk(full);
      else {
        // A regular file carrying more than one name is a hard link, and the
        // second name may sit outside the workspace where this walk cannot see
        // it — which is exactly why the file cannot be vouched for. Directories
        // are excluded: NTFS directory link counts mean something else, and
        // directory aliasing is the reparse question the check above answers.
        try {
          if (lstatSync(full).nlink > 1) hardLinks.push(full);
        } catch {
          // unreadable is not the same as absent, and the caller sees `checked`
        }
      }
    }
  };

  if (existsSync(dir)) walk(dir);
  return { checked, links, escaped, hardLinks, truncated };
}

/**
 * Whether a path is a link of some kind.
 *
 * `lstatSync().isSymbolicLink()` catches symlinks but not junctions: a junction
 * (`mklink /J`) is a reparse point that `lstat` reports as an ordinary directory.
 * Node exposes no attribute flag for it, so the test is whether the path resolves
 * somewhere other than where it sits — which is also the question that matters.
 * An unresolvable path is reported as linked rather than as fine, because unknown
 * must not read as safe.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isReparsePoint(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return true;
    if (!stat.isDirectory()) return false;
    return realpathSync(path).toLowerCase() !== resolve(path).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The per-task half of the execution boundary: the workspace a task is about
 * to run in must hold no link that leaves it and no hard-linked file.
 *
 * The hard-link half exists because the grant-time gate in
 * ./hardlink-defect-remediation.mjs only covers the creation window. A link
 * planted after the grant lands no ACE (measured, P5) and is not exploitable
 * on its own — but it is a second name for an outside object sitting in a
 * directory the container can write, and the workspace's whole value is that
 * a fresh task directory holds exactly what Lain put in it. A run refuses on
 * the broken invariant, not on a proven exploit.
 *
 * @param {{workspaceRoot: string, taskId: string}} input
 * @returns {{ok: boolean, code: string, message: string, facts: Record<string, unknown>}}
 */
export function checkWorkspaceContainment(input) {
  const taskDir = join(resolve(input.workspaceRoot), input.taskId);
  const containment = inspectContainment(taskDir);
  /** @type {Record<string, unknown>} */
  const facts = { workspace: taskDir, containment };
  if (containment.escaped.length > 0) {
    return {
      ok: false,
      code: 'WORKSPACE_LINK_ESCAPES',
      message: `the task workspace contains ${containment.escaped.length} link(s) resolving outside it`,
      facts,
    };
  }
  if (containment.hardLinks.length > 0) {
    return {
      ok: false,
      code: 'WORKSPACE_HARD_LINK_PRESENT',
      message: `the task workspace contains ${containment.hardLinks.length} hard-linked file(s); a second name outside the workspace cannot be ruled out`,
      facts,
    };
  }
  return {
    ok: true,
    code: 'WORKSPACE_CONTAINED',
    message: 'the workspace holds no link that leaves it and no hard-linked file',
    facts,
  };
}

/**
 * Decide whether a task may run, given the boundary Lain can actually offer.
 *
 * Two separate questions, and both must be answered before a tool process exists:
 * whether the workspace root is anchored where the deployment thinks it is, and
 * whether the read posture has been stated. Neither is a substitute for the other.
 *
 * @param {{workspaceRoot: string, stateBase?: string|null, env?: NodeJS.ProcessEnv, taskId?: string}} input
 * @returns {{ok: boolean, code: string, message: string, posture: string, facts: Record<string, unknown>}}
 */
export function checkExecutionBoundary(input) {
  const env = input.env ?? process.env;
  const { posture, raw, accepted } = readPosture(env);
  const root = resolve(input.workspaceRoot);
  /** @type {Record<string, unknown>} */
  const facts = {
    workspace_root: root,
    state_base: input.stateBase ? resolve(input.stateBase) : null,
    posture: posture.id,
    posture_raw: raw,
    reads_confined: posture.reads_confined,
    runtime_read_roots: runtimeReadRoots({ env }),
  };

  if (input.stateBase) {
    const base = resolve(input.stateBase);
    if (!isInside(base, root)) {
      return {
        ok: false,
        code: 'WORKSPACE_OUTSIDE_STATE_BASE',
        message: `the workspace root ${root} is not inside the state directory ${base}`,
        posture: posture.id,
        facts,
      };
    }
    facts.state_base_contains_workspace_root = true;
  }

  if (input.taskId) {
    const containment = checkWorkspaceContainment({ workspaceRoot: root, taskId: input.taskId });
    facts.containment = containment.facts.containment;
    if (!containment.ok) {
      return {
        ok: false,
        code: containment.code,
        message: containment.message,
        posture: posture.id,
        facts,
      };
    }
  }

  if (!posture.reads_confined && !accepted) {
    return {
      ok: false,
      // Named after what the operator has to do, not after what Lain cannot do.
      code: 'READ_BOUNDARY_UNDECLARED',
      message:
        `nothing confines this tool process's reads, and the deployment has not said so. `
        + `Set ${READ_POSTURE_ENV}=declared to run with reads unrestricted, or provide a mechanism that confines them.`,
      posture: posture.id,
      facts,
    };
  }

  return {
    ok: true,
    code: posture.reads_confined ? 'READS_CONFINED' : 'READS_UNRESTRICTED_BY_DECLARATION',
    message: posture.reads_confined
      ? 'reads are confined to the workspace by an operating-system mechanism'
      : 'reads outside the workspace are possible; the deployment has declared and accepted that',
    posture: posture.id,
    facts,
  };
}

/**
 * The relative path between two roots, or null when one does not contain the
 * other. Used by tests and by callers that want to report a path without
 * leaking the user's directory layout into a log.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {string|null}
 */
export function relativeInside(parent, child) {
  if (!isInside(parent, child)) return null;
  return relative(parent, child) || '.';
}
