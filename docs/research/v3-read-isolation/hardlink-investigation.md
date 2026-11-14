# V-3.1 hard-link investigation

Date: 2026-11-14 · Repo: lain @ 257532d · Author: security-verification pass (V-3.1)

## Question

Can an untrusted task running inside Lain's real AppContainer gain read access to a
file outside the workspace through a hard link, and can the CLI workflow
(workspace creation → ACL grant → execution) be abused to make that happen?

The V-3 feasibility study (`appcontainer-feasibility.md`, same directory) already
recorded the mechanism: when `icacls <workspace> /grant *<container-sid>:(OI)(CI)M`
runs on a directory that holds a hard link to an outside file, the ACL rewrite walks
every name that references the same file ID — including the outside name — and lands
the container ACE on the outside object. What V-3.1 had to establish:

1. whether the container itself can create such a link (self-service attack), or
   only a principal holding the user's rights can plant one;
2. whether the "narrow exposure" claim in `docs/memory/CURRENT_STATE.md` (fresh
   workspace cannot hold a pre-existing link) survives an active attacker racing
   the grant;
3. what the minimal, evidence-based mitigation is.

## Environment (reproduction baseline)

- Windows 11, account `kirb\lain`, non-elevated, filtered token (Administrators
  deny-only). No elevation was used at any point.
- Node 24.21.0 (repo pin), repo HEAD `257532d`, clean tree.
- AppContainer profile `lain.tool.runner`; SID
  `S-1-15-2-4156793909-553355631-1844774931-1801508839-3101138585-3860741030-1640126254`
  as printed by `src/exec/job.mjs` `containerSid()`. AppContainer SIDs are derived
  from the profile name, so a fresh machine with the same profile yields the same SID.
- Experiment harness lives outside the repo (`%TEMP%\lain-hl-exp\`) so the repository
  stays clean; every result below was captured to text and rendered to the PNGs
  referenced per experiment. The PNGs are renderings of the captured run output,
  not screen photographs.

## Mechanism, stated precisely

The grant is `icacls <dir> /grant *<sid>:(OI)(CI)M`. `(OI)(CI)` marks the ACE
inheritable, and NTFS inheritance propagation follows hard links: the security
descriptor rewrite enumerates every name that references the same file ID and
re-derives inherited ACEs through each of them. A hard link is not a reparse point,
so `inspectContainment` in `src/exec/boundary.mjs` — which reports symlinks and
junctions — never sees it. Two consequences:

- a link planted **before** the grant pulls the container ACE onto the outside
  object (E1);
- a link planted **during** the mkdir→grant window does the same (E3): the window
  is the whole grant duration, measured 9.51–18.89 ms over 20 trials, and a
  separate watcher process won it 20/20.

The container itself cannot plant the link (E2): `CreateHardLink` from inside the
AppContainer requires WRITE access on the source object, and every target the
container cannot already read was refused with EPERM/-4048.

## E1 — defect replication (end to end)

Purpose: reproduce the recorded defect with the real container SID, real grant
command, and a real in-container read, capturing file IDs, link counts and ACLs at
each step. Evidence: `evidence-e1-defect.png`.

Commands (exact, from a non-elevated PowerShell; `%SID%` is the container SID above):

```powershell
$out = "$env:TEMP\hl-e1\outside"; $ws = "$env:TEMP\hl-e1\ws"
New-Item -ItemType Directory -Force $out, $ws | Out-Null
icacls $out /inheritance:r /grant:r "$env:USERDOMAIN\$env:USERNAME:(OI)(CI)F"
Set-Content "$out\secret.txt" 'SECRET-CANARY'
Set-Content "$out\other.txt" 'OTHER-CANARY'
# plant the link as the user, BEFORE the grant:
cmd /c mklink /H "$ws\hard.txt" "$out\secret.txt"
# grant exactly what src/exec/workspace.mjs runs:
icacls $ws /grant "*$env:LAIN_CONTAINER_SID:(OI)(CI)M"
icacls "$out\secret.txt"          # -> container ACE present
icacls "$out\other.txt"           # -> unchanged (control)
```

Observed metadata (file ID = `statSync().ino`, which Node obtains via
`GetFileInformationByHandle`):

| step                          | secret ino      | secret nlink | other ino      | other nlink |
| ----------------------------- | --------------- | ------------ | -------------- | ----------- |
| T0 before link                | 2533274792037895 | 1           | 3659174698880522 | 1         |
| T1 link planted               | 2533274792037895 | 2           | 3659174698880522 | 1         |
| T2 after grant                | 2533274792037895 | 2           | 3659174698880522 | 1         |

Observed ACLs:

| object                        | before grant      | after grant |
| ----------------------------- | ----------------- | ----------- |
| `outside\secret.txt` (linked) | `kirb\lain:(I)(F)` | `S-1-15-2-…-1640126254:(I)(M)`, `kirb\CodexSandboxUsers:(I)(RX)`, `SYSTEM:(I)(F)`, `Administrators:(I)(F)`, `kirb\lain:(I)(F)` |
| `outside\other.txt` (control) | `kirb\lain:(I)(F)` | `kirb\lain:(I)(F)` — unchanged |

The outside directory was `/inheritance:r`-protected and never granted directly;
the container ACE arrived purely through the link. In-container reads after the
grant: `secret.txt` by its own path and via the link both returned the canary
(`READ:SECRET-CANARY-…`), the granted control read fine, the unlinked `other.txt`
refused with EPERM/-4048. The defect is real end to end.

## E2 — can the container create the link itself?

Purpose: rule out (or confirm) self-service exploitation. From inside the
AppContainer, `fs.linkSync` attempts against four target classes. Evidence:
`evidence-e2-container-links.png`.

| link target (from inside the container)            | result      |
| -------------------------------------------------- | ----------- |
| file in a directory the container cannot traverse  | EPERM/-4048 |
| unreadable file in a traversable directory `(CI)RX`| EPERM/-4048 |
| **readable** external file (dir `(OI)(CI)RX`)      | EPERM/-4048 |
| file in another granted workspace (positive control)| LINK-CREATED |

The third row is the important one: even a fully readable target is refused.
Measured rule: `CreateHardLink` requires WRITE access on the source object, which
the container never has outside its own workspace. All granted workspaces share one
container SID, so cross-workspace links succeed — that is the existing read model,
not a new exposure. Conclusion: the attack needs a principal holding the user's
rights to plant the link; the container cannot initiate it.

## E3 — the mkdir→grant race

Purpose: test the "narrow exposure" claim against an active attacker. A separate
node process watches the workspace root with `fs.watch`; on every new `ws-*`
directory it immediately plants `race.txt → outside\secret-<name>.txt`. The driver
runs 20 trials of `mkdir ws-N` → `icacls grant`, one fresh secret per trial.
Evidence: `evidence-e3-race.png`.

Result: **20/20 links planted by grant end, 20/20 container ACEs landed on the
outside secrets.** Timing over the 20 trials: grant min 9.51 / mean 12.46 /
max 18.89 ms; mkdir min 0.11 / mean 0.21 / max 0.71 ms. The attacker does not need
to hit a microsecond window — the window is the entire grant call, and a watcher
that reacts to directory creation wins every time. The "fresh workspace cannot hold
a pre-existing link" claim in `CURRENT_STATE.md` holds only against a passive
attacker and is retired by this measurement.

## E4 — the shipped gate (remediation under test)

Purpose: validate the mitigation as implemented in
`src/exec/hardlink-defect-remediation.mjs` and wired into
`src/exec/workspace.mjs` `create()`. Evidence: `evidence-e4-gate.png`.

- Flow A (link present before the gate): `createWorkspace` threw
  `WORKSPACE_HARD_LINK_PRE_GRANT`, the grant never ran, no container ACE on the
  outside secret, container read EPERM/-4048.
- Flow B (deterministic race replay — the link is planted between the pre-scan and
  the grant, i.e. inside the grant callback): the gate threw
  `WORKSPACE_HARD_LINK_GRANT_ESCAPED`, the post-scan found the landed ACE, cleanup
  removed it (`removed=true`), container read EPERM/-4048, and the outside object's
  ACL afterwards was the converted non-inherited set (`CodexSandboxUsers:(RX)`,
  `SYSTEM:(F)`, `Administrators:(F)`, `kirb\lain:(F)`) — same access as before the
  incident, container ACE gone.

## E5 — cleanup matrix (why the shipped cleanup looks the way it does)

Purpose: find the minimal reliable way to strip a container ACE that landed on an
outside object, when the only path the fixer holds is the link inside the (now
refused) workspace. Evidence: `evidence-e5-cleanup.png`.

| scenario | command path | `/remove` status | ACE after | verdict |
| -------- | ------------ | ---------------- | --------- | ------- |
| D control | external path directly | 0 | gone | works, but the fixer normally has no outside path |
| A trap | link path only | 0 — "Successfully processed 1 files" | **still there** | silent failure: the DACL rewrite re-derives inherited ACEs from the parent *of the path used*; via the link that parent is the granted workspace, so the ACE is inherited straight back |
| B | clean the workspace dir first, then `/remove` via the link | 0 | gone | rejected: the rewrite re-derives the outside object's inherited ACEs from the workspace chain — ACL corruption of an outside object |
| C (shipped) | `/inheritance:d` via the link, then `/remove` via the link | 0 / 0 | gone | chosen: detach first so the rewrite cannot re-derive, then remove; DACL becomes protected, pre-incident access preserved, container read back to EPERM/-4048 |

Side effect of C, bounded and accepted: the outside object's DACL becomes
protected (no future inheritance from its real parent). The alternative — leaving
the container ACE on an outside file — is strictly worse.

## F — scan behavior under denies

Purpose: prove the pre-grant scan cannot be blinded by ACL denies. Evidence:
`evidence-f-scan.png`.

- Control (files + `.tmp`, no links): 0 findings.
- One link: found on both names, same file ID (`ino=1407374885317480`), `nlink=2`.
- `icacls /deny OWNER:(R)` on one name of the pair: `lstatSync` still reports the
  true `nlink=2` (libuv stats through the parent directory, bypassing the file
  DACL), `openSync('r')` fails EPERM/-4048 on both names, and the scan still finds
  the pair.
- `icacls /deny OWNER:(RX)` on a subdirectory: `readdirSync` fails EPERM/-4048 and
  the scan reports that path as an error finding — fail-closed, not skipped.

## Verdict

**Partially Secure (mitigation needed)** — and the mitigation is now implemented.

- The AppContainer itself holds: the container cannot read outside the granted
  workspace, cannot create links to objects it cannot write, and cannot reach the
  network (feasibility study, re-confirmed here by E2).
- The defect is exploitable only by a local process already holding the user's
  rights, racing the workspace grant (E1 + E3). That is the same privilege that
  could simply read the file directly — the marginal gain is persistence of access
  after the workspace is destroyed, which is exactly what makes it worth defending.
- With the shipped gate: pre-planted links are refused before any grant (E4 Flow
  A), grant-time escapes are detected and stripped (E4 Flow B, E5 C), and the
  outside object ends with no container ACE and its pre-incident access intact.

## Remediation (implemented, uncommitted)

- `src/exec/hardlink-defect-remediation.mjs` (new): `scanForHardLinks` (lstat-based;
  hard links are never reparse points; unreadable paths become error findings —
  fail-closed), `stripContainerAce` (`/inheritance:d` then `/remove`, per E5),
  `enforceLinkIsolation` (pre-scan → refuse `WORKSPACE_HARD_LINK_PRE_GRANT`; grant
  runs inside the gate; post-scan → cleanup then refuse
  `WORKSPACE_HARD_LINK_GRANT_ESCAPED`). Header comment carries the measured facts.
- `src/exec/workspace.mjs`: the container grant in `create()` now runs inside
  `enforceLinkIsolation`; `LinkIsolationError` maps to `WorkspaceError` with the
  same codes, so callers see no new error type.
- `test/exec/hardlink-remediation.test.mjs` (new): 6 unit tests (no SID needed) +
  contained AT-V3-HL-06/07/08. The pre-existing AT-V3-HL-01..05 in
  `test/exec/path-shapes.test.mjs` are unchanged — they measure OS-level icacls
  semantics and remain true statements; the defect mechanism they record is what
  the new gate defends against.

Before/after diff: `hardlink-remediation.diff` in this directory (generated with
`git diff` after `git add -N`, so the new files appear; nothing is staged for
commit beyond intent-to-add and nothing is committed or pushed).

## Test status

- Before any change, at HEAD `257532d`: `npm test` 239/239 pass, 0 fail — the
  reported "5 failing AppContainer tests" did not reproduce in this environment;
  `test/exec/path-shapes.test.mjs` was run three times to rule out flakiness.
- After the remediation: `npm test` 248/248 pass (239 + 9 new), and
  `npm run verify` 8/8 checks pass (see `hardlink-investigation.md` § Test status
  and the verify log snippet in the final report).

## V-3.2: the edge cases, measured and closed

The limits above were probed (P1–P5) and then turned into tests
(`test/exec/hardlink-edge-cases.test.mjs`, AT-V3-HL-09..13). Nothing here needed a
new mitigation except the last row.

| Shape | Measured result |
| --- | --- |
| UNC `\\localhost\c$\...` (user) | link refused EXDEV/-4037; nothing left behind |
| UNC `\\?\UNC\...` (user) | refused EXDEV/-4037 |
| `\\?\GLOBALROOT\...` (user) | refused ENOENT/-4058 |
| UNC share / device (container) | refused UNKNOWN/-4094; GLOBALROOT ENOENT/-4058; local control LINK-CREATED proves the probe |
| Mount-point junction planted before the grant | grant proceeds; **no ACE propagates through it** — the junction itself carries the ACE, the target directory and file stay clean; the container cannot read through it (EPERM/-4048) |
| Outside file held open FILE_SHARE_NONE | link creation succeeds despite the lock; `lstat` still reports the true nlink=2; the scan reports the finding; the gate refuses; and `stripContainerAce` works under the lock — the DACL rewrite is not blocked by a sharing violation |
| Link planted **after** the grant (the window this task targeted) | no ACE lands (the gate already ran) and the container cannot read through it (EPERM/-4048) — not exploitable as-is, but it breaks the fresh-workspace invariant a future grant would light up |

Two defects in the shipped V-3.1 code were found while wiring the post-grant
defense, both fixed:

- `inspectContainment` never ran in production: the CLI called
  `checkExecutionBoundary` without a task id, so the junction refusal
  (`WORKSPACE_LINK_ESCAPES`) was dead code. The runner now checks containment
  explicitly after workspace creation.
- `enforceLinkIsolation` rethrew the grant failure's *message string* instead of
  the error object, breaking the `WorkspaceError` contract on a failed grant
  with a clean post-scan. The original error is rethrown; the test now asserts
  identity, not a message regex.

What was added:

- `src/exec/boundary.mjs`: `inspectContainment` reports `hardLinks[]` (files with
  `nlink > 1`, fail-closed like the rest of the walk); new
  `checkWorkspaceContainment({workspaceRoot, taskId})` returns
  `WORKSPACE_CONTAINED` / `WORKSPACE_LINK_ESCAPES` / `WORKSPACE_HARD_LINK_PRESENT`;
  `checkExecutionBoundary` delegates to it when given a task id.
- `src/agent/task-runner.mjs`: the containment check runs right after the
  workspace is created and before any tool is registered. A refusal fails the
  task (or hands it to the canceller if a cancellation already landed), destroys
  the workspace, and no tool ever runs in it.
- `src/exec/hardlink-defect-remediation.mjs`: the scan no longer recurses into
  reparse directories (a junction's target is walked as itself, which could hide
  findings behind an unreadable outside tree; unresolvable reparse targets fail
  closed as findings).

With the gate plus the run-time check, the residual exposure is: a link planted
after the containment check gains nothing, because no ACL grant touches the
workspace after that point — the ACE lands only at grant time, and the check is
the last thing that runs before the tools. A local process holding the user's
rights can still race the check itself, which is the same privilege that could
read the outside file directly.

## Known limits (not tested here)

Carried over from the feasibility study, still open: `\\?\GLOBALROOT` volumes
beyond the probe (creation refused ENOENT either way) and targets held open with
handles already carrying *granted* access beyond the share-lock case measured
above.
