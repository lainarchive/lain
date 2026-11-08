# 08 — Final Verification Report

**Status:** Assignment complete. M-1's reported completion is **independently verified**, with one documentation overstatement found and corrected and one guarantee restated accurately.
**Date:** 2026-11-08
**Scope:** the whole M-1 Verification Closure & M-2 Readiness Gate assignment.
**Independently verified?** Every command, count, exit code and measurement in this package was produced in this session. Where something could not be established, it is labelled NOT-TESTABLE rather than inferred.

## A. Current repository state

| Field | Value |
|---|---|
| Repository root | `C:/Users/frick/Documents/Projects/lain` |
| Branch / HEAD | `main` / `38a5e6699b273dc64dfa84ca41d592dbac34524e` |
| Commits | 18 |
| Tracking | `main...origin/main [ahead 10]` |
| Tracked files / staged / modified | 81 / 0 / 0 at the start of the assignment |
| Remote | `https://github.com/lainarchive/lain.git`; live `main` still `7074c0dbad9ade15bc2a1017087386bbb058c760` |
| Identity | local `lain <lixkirb@gmail.com>`; global empty |
| Protected locations | B `0e7fdee`; `.lain-audit` 144 files / 149 585 363 B; V bundle `D9277951…`; W 161 files; M-1 backup 39 files — **all unchanged** |

**No discrepancy with the reported state was found**, so no stop condition applied and no work was abandoned.

## B. Event-store ownership

**The exact guarantee is A — one write transaction at a time — and not B, continuous process ownership.**

- Code: `appendMany` requires the lock (`WRITER_NOT_OWNED` otherwise), commits, then re-takes `BEGIN IMMEDIATE` synchronously; failure to re-take throws `STORE_LOCK_LOST` with the committed sequence in the detail.
- Measured: with four competitors polling `BEGIN IMMEDIATE`, writer A lost the lock at 651, 613 and 375 committed batches across three runs, and **4 of 4** competitors acquired it every time. A's outcome in all three runs: `{"a_error":"STORE_LOCK_LOST","holds":false}`.
- **The loser is refused, not silently allowed to continue** — the fail-closed behaviour is correct; only the *description* was wrong.
- **Documentation corrected** in three places with the smallest possible change: `SYSTEM_BOUNDARIES.md` (now "exactly one write transaction at a time", with the window and the refusal described and the measurement cited), `docs/implementation/event-store.md` (guarantee renamed, a "what this does not guarantee" subsection added, the window listed as limitation 2), and the comment in `src/store/index.mjs`.
- **Recommendation, not a decision:** keep transaction serialization; treat `STORE_LOCK_LOST` as a first-class outcome; the distinct-Event-Store *ownership model* stays a recommendation.

## C. Backup restore

**Restore-verified.** Destination `%TEMP%\lain-restore-verify-2026-11-08` (absent before use, outside every protected location), then removed. 37 expected / 37 restored / 0 missing / 0 unexpected / **0 size or SHA-256 mismatches** / 934 165 bytes exactly; excluded directories absent; 0 reparse points; nine root documents and the 556 115-byte recovered transcript present. The source backup was re-verified afterwards and is unchanged (`MANIFEST.csv` sha256 `8DED00CD…`).

**Coverage gap, needing a decision:** the backup predates all implementation, so `src/`, `test/`, `tools/`, `package.json`, `tsconfig.json`, `RESOURCE_BUDGET.md` and the three corrected documents exist in **no backup** — only in 18 local commits on one disk.

## D. Security scanner

`gitleaks` is absent (verified across `PATH` and four common install locations; no Go toolchain; `winget` available). Advisory mode reports `SKIP` with "this is NOT a clean scan" and exits 0. Required mode (`npm run verify`) reports `FAIL` and **exits 1**. Scanning scope is the working tree of the intended paths only, skipping `.git`, `node_modules`, `.lain-audit` and `artifacts`. **No scanner was installed and the gate was not bypassed.** Recommended $0 route: the prebuilt Windows release binary. **No full-history scan has ever run**, and the absence of fallback hits is not evidence that no secret exists.

## E. Regression tests

| Command | Result | Exit |
|---|---|---|
| `npm test` | 110 tests, 110 pass, 0 fail | 0 |
| `npm run check` | 8 checks: 7 pass, 0 fail, 1 skip (`secrets`, advisory) | 0 |
| `npm run check:self` | 8 checks: 8 pass, 0 fail — every check proved able to fail | 0 |
| `npm run verify` | 7 pass, **1 fail** (`secrets`, required) | **1** |
| `npm run check:store-boundary`, `npm run check:repo` | pass | 0 |

The single non-zero exit is the required security gate refusing while the scanner is missing — the intended behaviour. Re-run after the corrections: still 110/110 and 7 pass / 1 skip.

## F. Low-integrity toolchain experiment

Harness written fresh (`LowIlToolchain.cs` + `low-probe.ps1`), **non-elevated**, disposable `%TEMP%` workspace labelled `(OI)(CI)(NW)` Low. Evidence the boundary applied: every created file carries `Mandatory Label\Low Mandatory Level:(I)(NW)`.

**Allowed (positive controls, inside the workspace):** read, create, modify, run Node, run Python, Git `init`/`add`/`commit` with a full object store, spawn a child process, read project-local config.
**Denied (negative controls):** writes to an unlabelled sibling, to a second unlabelled `%TEMP%` parent, to a deliberately never-labelled third directory, and to the `%TEMP%` root — all refused, with **every escape artefact confirmed absent on disk**, while the same write inside the workspace succeeded.

**Three findings that each produced a wrong answer first:** `WRITE_RESTRICTED` with an empty restricting-SID list makes the child exit 0 while doing nothing; the child needs a fully qualified executable path (`error=2` otherwise); `icacls /setintegritylevel` labels the directory and future children, not pre-existing files.

**Not contained, stated plainly:** reads are unrestricted by MIC; other Low-labelled locations remain writable; UI/COM escalation, network reachability and resource limits were **not tested**; the native `CreateFileW` probe was NOT-TESTABLE at Low IL because `Add-Type` requires a Medium-integrity `%TEMP%`.

**Conclusion: PASS** for the tested write boundary and the tested toolchain operations. **A PASS here does not authorize M-2.**

**Cleanup:** lab contents recorded (56 entries) before deletion; exactly the three `lain-lowil-*` directories created by the experiment were removed and verified gone; the repository working tree was unchanged.

## G. M-2 readiness

Satisfied: the low-integrity toolchain question is answered (PASS with stated limits).
Proposed but undecided: hybrid cancellation by effect class; the ten-rule model-binding contract.
Still unresolved: the read boundary, resource limits, the Job Object lifecycle implementation, backup coverage for code, and **explicit authorization**.
**The current repository must not be described as sandboxed.** The accurate claim is a write boundary around a labelled workspace, measured against four escape attempts, with reads unrestricted and UI/COM, network and resource limits untested.

## H. Git state

- One local commit created for this assignment: subject **`test: verify M-1 foundation and containment prerequisites`**, containing the three corrections, the three new documents' supporting files, and the ten documents under `docs/research/m1-verification-closure/`.
- No push, no fetch, no pull, no branch change, no amend, no history rewrite, no protected-location modification, no secret or generated file staged.

## I. Recommended next action

**Take a new independent backup of the repository as it now stands, before anything else.** It is the only step that requires no new decision, costs minutes, and closes the single largest risk this verification found: M-1's implementation currently exists in exactly one place — 18 unpushed commits and one working tree on one disk — while the one verified-restorable backup predates all of it. After that, the decision that actually unblocks progress is **D-V1 (cancellation semantics)**, because the tool-execution path cannot be written honestly without it.

**Do not start M-2.** The five prerequisites are not all met, and this assignment was explicitly not authorized to implement it.
