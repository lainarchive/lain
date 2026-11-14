/**
 * The hard-link gate around the workspace grant.
 *
 * `icacls <workspace> /grant *<sid>:(OI)(CI)M` does not stop at the directory:
 * its propagation walk follows hard links and writes the inheritable ACE onto
 * the object a link names — a file whose real parent is somewhere else
 * entirely. Measured 2026-11-14
 * (docs/research/v3-read-isolation/hardlink-investigation.md, E1): with a link
 * planted before the grant, the ACE lands on the outside file even when its own
 * directory is /inheritance:r-protected and was never granted, and the container
 * then reads the file through its own path.
 *
 * The container cannot plant that link itself. CreateHardLink from inside the
 * AppContainer wants write access on the source object — a merely readable
 * outside file is refused with EPERM/-4048, one the container can read
 * included (E2). So the link always comes from a principal holding the user's
 * own rights, and the only moment it matters is between the workspace's mkdir
 * and the grant: a watcher on the workspace root won that race in 20 of 20
 * trials against a 14–23 ms grant (E3). "The workspace is fresh, therefore
 * empty" holds against a passive attacker and nobody else.
 *
 * The gate is two scans around the grant, and a refusal that cleans up after
 * itself:
 *
 *   before the grant  any link → refuse; the grant never runs, no ACE moves
 *   after the grant   any link → the ACE may be sitting on an outside object
 *                     right now; take it back off (see stripContainerAce) and
 *                     refuse the run
 *
 * Ordinary workspace content — files, subdirectories, .tmp scratch — scans
 * clean (E4 control), so the gate costs one walk of an almost-empty directory.
 * The scan reads link counts with lstat, and lstat is measured to see through
 * file-level ACL denies: libuv stats through the parent directory, so a file
 * the reader cannot open still reports its true link count (probe E: deny (R)
 * on one name of a link pair, lstat nlink=2). A directory that cannot be
 * listed at all comes back as a finding instead — deny (RX) on a subdirectory
 * turns readdir into EPERM/-4048, and the scan refuses on it.
 *
 * Runtime links are a different question, already answered: a tool inside the
 * container can only link what it can already write, and a link between two
 * objects inside one granted workspace carries no new access. The gate exists
 * for the creation window alone.
 *
 * V-3.2 measured the remaining shapes (hardlink-investigation.md, P1–P5):
 * UNC and \\?\GLOBALROOT link targets are refused at creation for the user
 * (EXDEV/ENOENT) and the container alike, a junction planted before the grant
 * carries no ACE onto its target and cannot be read through, a file held open
 * with FILE_SHARE_NONE neither hides its link count from lstat nor blocks the
 * DACL rewrite stripContainerAce performs, and a link planted after the grant
 * lands no ACE. The defense for that last window is not here — it is the
 * per-task containment walk in ../exec/boundary.mjs, which the task runner
 * calls between workspace creation and the first tool call.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Surfaced as WorkspaceError codes by the caller in ./workspace.mjs. */
export const PRE_GRANT = 'WORKSPACE_HARD_LINK_PRE_GRANT';
export const GRANT_ESCAPED = 'WORKSPACE_HARD_LINK_GRANT_ESCAPED';

/**
 * A finding is either a link (the object carries more than one name) or a path
 * the scan could not read. The second kind exists because a scan that cannot
 * vouch for a path has not vouched for it, and a security gate that silently
 * skips what it could not read is a gate with a hole in it.
 */
export class LinkIsolationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{findings?: Array<object>, cleanup?: Array<object>, [key: string]: unknown}} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'LinkIsolationError';
    this.code = code;
    this.findings = detail.findings ?? [];
    this.cleanup = detail.cleanup ?? [];
    this.detail = detail;
  }
}

/**
 * Every file under `dir` whose hard-link count is above one.
 *
 * lstat, not stat: a symbolic link is a reparse point the boundary check
 * already refuses, and stat would follow it and describe the target instead of
 * the workspace's own entry. A hard link is never a reparse point, so lstat
 * sees its true link count.
 *
 * Never throws: a path that cannot be read comes back as a finding, and a
 * finding refuses the run.
 *
 * @param {string} dir
 * @returns {Array<{path: string, ino?: number, nlink?: number, error?: string}>}
 */
export function scanForHardLinks(dir) {
  /** @type {Array<{path: string, ino?: number, nlink?: number, error?: string}>} */
  const findings = [];
  /** @param {string} current */
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      findings.push({ path: current, error: /** @type {NodeJS.ErrnoException} */ (err).code ?? String(err) });
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        // A mount point is a directory that resolves elsewhere; what sits behind
        // it is not the workspace's own content, and the boundary check refuses
        // the junction itself before any tool runs (measured: the grant's ACE
        // propagation does not cross a junction, and the container cannot read
        // through one). Scanning behind it would report objects the workspace
        // does not contain.
        if (resolvesElsewhere(full)) continue;
        walk(full);
        continue;
      }
      try {
        const s = lstatSync(full);
        if (s.nlink > 1) findings.push({ path: full, ino: s.ino, nlink: s.nlink });
      } catch (err) {
        findings.push({ path: full, error: /** @type {NodeJS.ErrnoException} */ (err).code ?? String(err) });
      }
    }
  };
  walk(dir);
  return findings;
}

/**
 * Whether a directory entry sits somewhere other than where it is named —
 * the junction and mount-point test, shared with the boundary walk's shape.
 * An unresolvable path reads as false here on purpose: the walk below it will
 * fail to list it and come back with an error finding, which refuses the run,
 * and unknown must not silently swallow content either way.
 *
 * @param {string} path
 * @returns {boolean}
 */
function resolvesElsewhere(path) {
  try {
    return realpathSync(path).toLowerCase() !== resolve(path).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Take the container ACE back off one object, through the workspace-side name.
 *
 * A bare `icacls <link> /remove *<sid>` does not stick, and it reports success
 * anyway (probe 2026-11-14: status 0, "Successfully processed 1 files", ACE
 * still on the outside file). Rewriting a DACL re-derives its inherited ACEs
 * from the parent of the path that was used — through the link that parent is
 * the granted workspace, so the ACE that was just removed is inherited straight
 * back. The same rewrite through the outside path sticks (E5), but the gate
 * only knows the link's name.
 *
 * So the removal is two steps, both through the link: `/inheritance:d` first,
 * which converts the inherited ACEs to explicit and protects the DACL against
 * re-derivation, then `/remove *<sid>`, which now strips the converted ACE and
 * nothing re-adds it (probe C: ACE gone and still gone). The side effect is
 * bounded and honest: the outside object's DACL stops following its own parent
 * from here on, but its effective access is exactly what it was the moment the
 * gate caught it, minus the container ACE. The alternative — cleaning the
 * workspace directory first and then rewriting through the link — also removes
 * the ACE (probe B) but re-derives the outside object's inherited ACEs from the
 * workspace's chain, replacing its ACL with one it never had. Rejected.
 *
 * `run` is the unit-test seam: a test injects a stub instead of shelling out.
 *
 * @param {string} path
 * @param {string} sid
 * @param {{run?: (args: string[]) => {status: number, out: string}}} [opts]
 * @returns {{attempted: boolean, removed: boolean, detail: string}}
 */
export function stripContainerAce(path, sid, opts = {}) {
  const run = opts.run ?? ((args) => {
    const r = spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true });
    return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  });
  const detached = run([path, '/inheritance:d']);
  if (detached.status !== 0) {
    return { attempted: true, removed: false, detail: `/inheritance:d failed: ${detached.out}` };
  }
  const done = run([path, '/remove', `*${sid}`]);
  return { attempted: true, removed: done.status === 0, detail: done.out };
}

/**
 * The gate workspace.create() grants inside.
 *
 * `grant` is the real icacls call as a callback so that each scan sits exactly
 * one statement from it on either side. It may throw its own grant failure,
 * which passes through untouched — a failed grant is the caller's error to
 * report. The post-scan still runs on that path, because a grant that exited
 * nonzero is not a proof that nothing propagated, and an ACE sitting on an
 * outside object is worse than the grant failure that may have caused it.
 *
 * @param {{dir: string, sid: string, grant: () => void,
 *   scan?: typeof scanForHardLinks, removeAce?: typeof stripContainerAce}} args
 */
export function enforceLinkIsolation({ dir, sid, grant, scan = scanForHardLinks, removeAce = stripContainerAce }) {
  const before = scan(dir);
  if (before.length > 0) {
    throw new LinkIsolationError(PRE_GRANT,
      'the workspace holds a hard link before the grant ran; granting would write the container ACE onto whatever it names',
      { findings: before });
  }
  /** @type {unknown} */
  let grantFailure = null;
  try {
    grant();
  } catch (err) {
    grantFailure = err;
  } finally {
    const after = scan(dir);
    if (after.length > 0) {
      const cleanup = after.map((finding) => ({ finding, ...removeAce(finding.path, sid) }));
      throw new LinkIsolationError(GRANT_ESCAPED,
        'a hard link appeared while the grant ran; the container ACE may be on an object outside the workspace',
        {
          findings: after,
          cleanup,
          ...(grantFailure ? { grant_error: grantFailure instanceof Error ? grantFailure.message : String(grantFailure) } : {}),
        });
    }
  }
  if (grantFailure) throw grantFailure;
}
