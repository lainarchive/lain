# 04 — Filesystem, Process, Network and Credential Boundaries

**Status:** PROPOSED specification for the M-2 execution boundary. Nothing implemented; nothing accepted.
**Date:** 2026-11-08
**Scope:** the enforcement design for the first bounded agent, expressed as decisions with reasons, plus the tests that would prove each one.
**Verification classification:** VERIFIED (measured here) · DOCUMENTED (Microsoft docs) · PROPOSED · UNRESOLVED · NOT-TESTABLE.
**Design rule (ESR):** *enforce on the object, not the path; own the process tree, do not trust it; declare what is not contained.*
**Related:** [02-windows-containment-research.md](02-windows-containment-research.md) (the mechanisms and what was measured) · [03-threat-model.md](03-threat-model.md) (what this is defending against) · [05-resource-and-lifecycle-contracts.md](05-resource-and-lifecycle-contracts.md) (the limit values referenced in §2.2) · [01-cancellation-semantics.md](01-cancellation-semantics.md) (the lifecycle that uses these boundaries).

---

## 1. Filesystem boundary

### 1.1 Paths and permissions

| Concern | Decision | Rationale |
|---|---|---|
| Workspace root | `%LOCALAPPDATA%\Lain\workspaces\<task_id>` — **not** under the repository and not under `%TEMP%` root | Keeps derived state out of the source tree; a stable root makes the label policy auditable |
| One workspace per task | Created fresh; **never** inherited | A inherited workspace carries reparse points and leftovers, which is how an escape container becomes a normal-looking file |
| Read | As the user account allows, **minus an explicit deny list** | MIC does not restrict reads ([MIC docs](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)) |
| Write | Only where the path is under the workspace **and** the object is Low-labelled | Verified: a write through a hardlink is denied because the check is on the object |
| Delete | Workspace only; the controller deletes, not the tool | A tool that can delete outside its workspace has more authority than the task granted |
| Temp files | `TEMP`/`TMP` pointed at `<workspace>\.tmp`; the directory exists before launch | Otherwise tools write to the user's Medium-integrity temp |
| Deny list (read) | `.lain-audit`, the backups (V, W, M-1, M-2 artifacts), the source repository's `.git`, `%APPDATA%`/`%LOCALAPPDATA%` credential stores, the user's `.ssh`/`.aws`/`.config` | Advisory where the path is checked, and **NOT-TESTABLE as an OS control today** — MIC does not stop these reads, so this is a policy surface, not a boundary |

**The honest statement for this table:** the deny list is enforced by the path check, and path checks are defeatable (§1.4). It is a **mitigation for careless actions, not a control against a hostile one.** The user must know that distinction, because it is the difference between "the agent cannot read your SSH key" and "the agent is told not to".

### 1.2 Labelling

- The workspace directory is labelled `(OI)(CI)(NW)` — Low, no-write-up, inherited by children.
- **Pre-existing files are labelled individually**: `icacls /setintegritylevel` labels the directory and *future* children, not existing files (measured, Verification E). Any file copied into a workspace must be labelled after the copy.
- Nothing else on the volume is relabelled. This is deliberate: the safety of the design comes from **Medium-by-default for unlabelled objects**, so the blast radius of a labelling mistake is one workspace.

### 1.3 Path validation (advisory, fast-fail) and its limits

Order of checks before touching anything: reject non-absolute paths → normalise → resolve → canonicalise the workspace root **once at task start** → require the resolved path to have the canonical root as a prefix on a component boundary → reject if any component is a reparse point → reject a path containing `:` outside the drive position (ADS), `\\?\`, `\\.\`, trailing dot or space, or a case variant of an existing name. **Each of those rejections exists because Phase 0 E5 measured it as an escape class** (9 of 11 contained, 2 not testable on this volume).

**Stated limits:** hardlinks are not detectable by this method at all — the fix is object-level (the write is denied), and detection is a monitoring exercise: `fs.statSync` on a workspace file with `nlink > 1` is an anomaly to record. A hardlink attack therefore degrades to "an anomaly was logged and the write was refused", not to "nothing happened".

### 1.4 What the path layer is actually for

**ESR.** It exists to reject obviously malformed input cheaply and to produce a clear error, **not** to be the boundary. The Phase 0 measurement settles this: seven bypass classes defeated path containment, three of them produced false ALLOWs, and a hardlink defeats every path check including `GetFinalPathNameByHandleW`. The boundary is the integrity label on the object; the path layer is a filter in front of it.

### 1.5 Artifacts, replacement, cleanup, backup

- A tool's result reports artifacts as `{path, bytes, sha256}`; the controller verifies the digest before recording it.
- File replacement is atomic where the tool permits (`rename` over the target), so a crash cannot leave a half-written artifact that the log cannot explain.
- On task end: the workspace is either **kept** (task completed, artifacts referenced), **quarantined** (task cancelled or `indeterminate`), or **deleted** (declared disposable). Which one applies is a policy decision recorded per task, never a side effect of how the process exited. This is OQ-CX-2.
- Backups never contain workspace contents unless a task explicitly produced a kept artifact; the workspace is not part of Lain's own backup set, which keeps the backup's meaning ("Lain's own state") unambiguous.

## 2. Process boundary

### 2.1 Job Object rules (DOCUMENTED, from Microsoft's Job Objects and nested-jobs pages)

1. **One job per task**, created before the first tool, handle held by the controller for the task's lifetime.
2. **`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` set.** Closing the last handle terminates every associated process — the mechanism that makes a controller crash a cleanup event rather than an orphan generator.
3. **Neither `JOB_OBJECT_LIMIT_BREAKAWAY_OK` nor `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` set**, so children join by default and cannot break away. The documented cost: a child that tries to associate itself with its own job will get a failure. **That failure is surfaced as a tool defect**, because silently continuing would mean the tree is not what the record says it is.
4. **Children are created suspended, assigned to the job, then resumed.** The documented race — a child that exits before assignment — is closed this way rather than hoped away.
5. **Executables are addressed by fully qualified path.** Measured: `CreateProcessAsUserW` with a bare `powershell.exe` fails `error=2 ERROR_FILE_NOT_FOUND` even though the parent's `PATH` contains it. This also removes a search-order attack surface.
6. **After every task, the job is enumerated.** Zero live processes is recorded as a verification event; a non-zero count is `cancel_failed`/`task.leaked_processes`, never a footnote.

### 2.2 Limits (flags verified in the API documentation; values are recommendations)

| Limit | Flag | Recommended | Basis |
|---|---|---|---|
| Simultaneous processes | `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` (0x8) | 3 | Matches the Phase 5 concurrency ceiling `min(4, cores−1)`; one concurrent tool call in v0.1 |
| Job-wide committed memory | `JOB_OBJECT_LIMIT_JOB_MEMORY` (0x200) | 6 GiB | `RESOURCE_BUDGET.md` memory ceiling (`min(6 GiB, free − 2 GiB)`) |
| Per-process committed memory | `JOB_OBJECT_LIMIT_PROCESS_MEMORY` (0x100) | 2 GiB | Leaves room for three processes under the job cap |
| Per-process user-time | `JOB_OBJECT_LIMIT_PROCESS_TIME` (0x2) | 300 s | The Phase 5 tool timeout |
| Job user-time | `JOB_OBJECT_LIMIT_JOB_TIME` (0x4) | 900 s | Bounds a task that spawns many short tools |
| Wall-clock | controller-side timer | per-task deadline | A job time limit is user-mode CPU time, not wall clock — the two must not be conflated |

**The unit trap is worth naming:** `PerProcessUserTimeLimit` and `PerJobUserTimeLimit` are in **100-nanosecond ticks** of user-mode time, so a "5 minute" limit that is set in milliseconds is off by 10 000×. In a nested job the effective limit is the most restrictive in the chain.

### 2.3 Lifecycle, crash recovery, timeout

- **Handle lifetime:** the controller holds the job handle and process handles until verification completes; handles are closed only after the enumeration event is written.
- **Timeout:** a per-call wall-clock timer owned by the controller. On expiry: `TerminateJobObject`, record `tool.timeout`, enumerate, mark the step failed. A timeout never becomes a retry by itself.
- **Controller crash:** the OS closes the handles, the job dies, no orphans. On restart the task is `indeterminate` — *not* `cancelled` and *not* `failed` — because the outcome of whatever was in flight is unknown. Recovery rules follow Phase 5 §7: every effect that cannot be proven from the log is surfaced, and re-running indeterminate work is an explicit decision, never a startup side effect.
- **Kill vs terminate:** `TerminateJobObject` is used for the tree; `TerminateProcess` on a single handle is used only when the job is already gone (e.g. the tool broke out, which is itself recorded as a defect).

## 3. Network boundary

**Current state: unenforced.** Nothing restricts a tool's network access, and MIC does not address it ([MIC docs](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control) describe write/read/execute-up only).

**PROPOSED for M-2 — policy, not enforcement:**
1. Every tool declares `network: none | loopback | internet` in its contract. The declaration is a hard filter in capability selection, exactly like cost class.
2. The policy default is **deny** for `loopback` and `internet` in v0.1; the M-2 tool set is local (read file, write file, run a script, git on a disposable repo), so nothing legitimate needs it.
3. Every invocation records its declared network class in the event, so a review can ask "did anything claim it needed the network" without trusting the tool's behaviour.

**The honest limit, which must be repeated wherever this is described:** this is a contract and a record, not a control. A tool that declares `none` and then opens a socket is not stopped by anything Lain currently builds. Closing that gap requires AppContainer with the network capability withheld ([AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation): "without the *network* capability, an AppContainer cannot access the network") — which is Tier 2, unmeasured, and not a promise.

## 4. Credential boundary

1. **No credential ever enters model context.** Tools receive an opaque *handle* — a name the controller resolves at the point of use — never a value. A tool result that appears to contain a credential is redacted before it is returned to the model, not after.
2. **No credential is stored in the event log.** Redaction-on-write is implemented and verified by scanning the database, WAL and SHM bytes.
3. **`env` is constructed, not inherited wholesale.** The child gets `PATH`, `SystemRoot`, `TEMP`/`TMP` (pointed at the workspace), `LANG`, and the workspace path; everything else is dropped, so a token that happens to live in the parent's environment is not handed to the tool. This is a mitigation, not a boundary — a tool can still read any file the user can read.
4. **Processes must not be able to reach unrelated credentials — and today they can.** `%USERPROFILE%\.ssh`, browser cookie stores and DPAPI-protected files are readable by the account. Named in the threat model as the largest single gap (OQ-TM-1). AppContainer's credential isolation ("prevents the use of user credentials to gain access to resources or login to other environments") is the documented remedy and is **unverified here**.
5. **Nothing in this section is tested against real credentials**, and no test may use them. Fixtures only, assembled at runtime so that no test file contains the secret it tests for — the rule learned twice during M-1.

## 5. Acceptance tests for the boundary

| ID | Test | Positive control |
|---|---|---|
| AT-BD-01 | Write outside the workspace is refused and the artefact is absent | the same write inside succeeds |
| AT-BD-02 | Write through a hardlink to an outside file is refused | a normal write to the same name inside succeeds |
| AT-BD-03 | Write through a junction/symlink is refused | direct write inside succeeds |
| AT-BD-04 | ADS, `\\?\`, `\\.\`, trailing dot/space, case-variant paths are refused | canonical path inside succeeds |
| AT-BD-05 | A grandchild process cannot survive cancellation | a normal task's processes all exit cleanly |
| AT-BD-06 | Controller killed mid-task leaves zero processes | a graceful end also leaves zero |
| AT-BD-07 | Job memory limit terminates an over-committing child | a child under the limit completes |
| AT-BD-08 | Per-process CPU-time limit terminates a spinning child | an idle child is not terminated |
| AT-BD-09 | A tool declaring `network: none` that opens a socket **is not stopped** — recorded as a known gap, not a pass | network declaration appears in the event |
| AT-BD-10 | `env` handed to the child contains only the allow-list | the child can still run Node/Git/Python |

**ESR — why AT-BD-09 is written as a failing test rather than omitted.** A boundary table with no row for network would let a reader assume network was handled. A row that says "not stopped" is the difference between a documented gap and a false claim.

## 6. Open questions

| # | Question | Blocks |
|---|---|---|
| OQ-BD-1 | Are npm/pip caches requirable per-workspace (`npm_config_cache`, `PIP_CACHE_DIR`), or must a shared Low-labelled cache be accepted? | Installing anything inside a contained task |
| OQ-BD-2 | Does the tool set need a shared Low-labelled temp outside the workspace? | Every additional shared writable region weakens AT-BD-01 |
| OQ-BD-3 | Is the read deny list enforced anywhere else (e.g. a Low-IL helper that performs reads on the tool's behalf), or accepted as policy? | OQ-TM-1 |
| OQ-BD-4 | Should a tool that legitimately needs its own job be supported (and how is it then contained)? | Tools like `py.exe` that create jobs internally |
