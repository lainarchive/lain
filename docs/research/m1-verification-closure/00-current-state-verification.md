# 00 — Current-State Verification

**Status:** Verified by direct measurement.
**Date:** 2026-11-08
**Scope:** re-derive the repository state rather than trust the completion report.
**Independent?** Yes — every field below was produced by a command in this session, not copied from the previous turn's summary.

## Repository

| Field | Value | Matches report |
|---|---|---|
| Session cwd | `C:\Users\frick\.codex\.chatgpt-projects\g-p-6aecffda1c588191b6f066b657f38c50\lainarchive-lain` (the read-only archive) | n/a — commands address the canonical path explicitly |
| Repository root | `C:/Users/frick/Documents/Projects/lain` | yes |
| Branch | `main` | yes |
| HEAD | `38a5e6699b273dc64dfa84ca41d592dbac34524e` | yes |
| Commits | 18 | yes |
| Tracking | `## main...origin/main [ahead 10]` | yes |
| Tracked files | 81 | not previously stated |
| Staged / modified | 0 / 0; `git status --porcelain` empty | yes |
| Remotes | 1 → `https://github.com/lainarchive/lain.git` | yes |
| Local identity | `lain <lixkirb@gmail.com>` | yes |
| Global identity | empty (name and email) | yes |
| Live remote `main` | still `7074c0dbad9ade15bc2a1017087386bbb058c760` | no push occurred |

Commit history (most recent six, all 2026-11-08):

```
38a5e66 fix: guard format.mjs entry point so importing it does not run the check
affdc67 docs: correct three canonical claims that implementation proved false
1482359 feat: add host capability probe and resource admission
7684519 docs: record the event store as implemented
e01dbb2 feat: implement bounded event store
379b4f2 build: establish reproducible verification environment
```

## Implementation inventory (33 tracked files under `src/`, `test/`, `tools/`)

`src/core/{errors,ids,json,validate}.mjs` · `src/store/{index,lock,redact,schema}.mjs` · `src/host/probe.mjs` · `src/budget/index.mjs` · `tools/verify.mjs` · `tools/probe.mjs` · `tools/check/{report→lib/report, runtime, layout, format, types, tests, secrets, repo-hygiene, store-boundary}.mjs` · `test/core/*` (4) · `test/store/*` (4) · `test/host/probe.test.mjs` · `test/budget/admission.test.mjs` · `test/tools/verification-meta.test.mjs` · `test/helpers/store-child.mjs`.

Package configuration: private, `"type": "module"`, **zero runtime dependencies**, dev dependencies exactly `typescript@7.0.2` and `@types/node@^24.19.2`, `engines.node = ^24.0.0`. Runtime `node v24.21.0`. Fifteen npm scripts, including `check`, `check:self`, `check:<name>` for each of the eight checks, `verify` (adds `--require-security`), `probe`, `test`.

## Protected locations (all unchanged)

| Location | Measured | Expected |
|---|---|---|
| Archive B HEAD | `0e7fdeeb28bbc26623765c88ba8816316c2c5fd5` | same |
| `.lain-audit` | 144 files, 149 585 363 B | same |
| Backup V full bundle | `D92779510D944C0C3F21E0D33C3CD46CADF90A70D5CCFA46680D89ADDA6FFCCD` | same |
| Backup W | 161 files | same |
| M-1 backup | 39 files (37 manifest rows + 2 artifacts) | same |

## Findings

1. **The reported state is accurate in every field checked.** No discrepancy was found, so no stop condition applied.
2. **81 tracked files** is the only figure not previously reported; it is consistent with the 29 (Step 1) + 11 (Step 2) + 9 (Step 3) + 3 (corrections) files plus the pre-existing documents and research.
3. **Nothing has been pushed, fetched, amended or rebased at any point.** The live remote query is the evidence, not the local tracking line.
4. **`test/tools/verification-meta.test.mjs` is 1 of 110 tests** — recorded here because it is the positive control for the check harness, not an ordinary unit test.

## Limitations

- The live remote check queries `refs/heads/main` only. A branch other than `main` could exist remotely; none is referenced by this repository's configuration.
- File counts for the protected backups were taken by recursive enumeration with reparse points not followed; `.lain-audit`'s single symbolic link is counted as one entry, which is how the historical 144 figure was derived.
