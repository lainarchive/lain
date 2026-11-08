# Build and verification system

**Status:** implemented. Every command below was executed on 2026-11-08 and its
result is recorded under `artifacts/verify/`.

**Runtime:** Node `24.21.0`, pinned by `.node-version` and `package.json`
`engines.node` (`^24.0.0`).

## 1. The commands

- `npm install` — installs the two development dependencies. No runtime
  dependency exists. Exit 0 on success.
- `npm test` — runs the unit tests through `node --test`. Exit 0 when all pass.
- `npm run check` — runs all eight checks. The secret-scan gate is **advisory**:
  an absent scanner is reported as `SKIP`, never as a pass. Exit 0 when no check
  fails.
- `npm run verify` — the same checks with the secret-scan gate **required**: an
  absent scanner is a failure. This is the gate for a release claim.
- `npm run check:self` — runs every check against a deliberately broken input.
  Exit 0 only when every check proved it can fail.
- `npm run check:<name>` — one check: `runtime`, `layout`, `format`, `types`,
  `tests`, `store-boundary`, `repo`, `secrets`.

`npm run verify` is the honest gate. `npm run check` exists so that ordinary work
is not blocked by a scanner that is not installed yet, while the report still
says `SKIP: gitleaks full scan` and "this is NOT a clean scan".

Every run writes an evidence log to `artifacts/verify/check-<timestamp>.log` or
`self-test-<timestamp>.log`. `artifacts/` is a designated evidence directory: it
is not committed, not secret-scanned, and not treated as project content.

## 2. The eight checks, and what each one can fail on

**`runtime`** — passes when `process.versions.node` matches `.node-version` and
`node:sqlite` exposes `DatabaseSync`, `StatementSync` and `backup`. Fails when
the runtime differs from the pin, the SQLite API is missing an expected export,
or `node:sqlite` cannot be imported.

**`layout`** — passes when the required directories exist and no forbidden
artifact is present. Fails when a documented directory is missing, or a database,
log, temporary file, model weight or `.env` file is present.

**`format`** — passes when owned files satisfy rules F-1…F-6. Fails on a BOM,
CRLF, tab indentation, trailing whitespace, a missing or doubled final newline,
or a line over 200 characters, in a file the policy owns.

**`types`** — passes when `tsc --noEmit` reports no diagnostics over `src/**` and
`tools/**`. Fails on any type error, or when the type checker is absent.

**`tests`** — passes when `npm test` exits 0 with a non-zero test count. Fails on
a failing test, a crashed runner, or **zero tests discovered**.

**`store-boundary`** — passes when no store source references an authorization
identifier. Fails when `decide(`, `authorize(`, `grantPermission` or a similar
identifier appears in `src/store/`.

**`process-boundary`** — passes when `node:child_process` appears only inside
`src/exec/`. Fails on an import or a bare spawn call anywhere else under `src/`,
and reports NOT-TESTABLE when `src/` contains no source files, because "no
violations" and "nothing to inspect" are different results.

The check was added in V-1 and immediately earned its place: it failed on
`src/host/probe.mjs`, which imported `execFileSync` to query `nvidia-smi`. The
answer was **not** to widen the allow-list — the next module with an equally
reasonable excuse would widen it again — but to add `src/exec/one-shot.mjs` and
route the probe through it. The check then produced a false positive on
`db.exec('PRAGMA busy_timeout = 0')`, a string method; `SPAWN_RE` gained the
`(?<![.\w])` guard so a method call is not mistaken for a process launch. A check
that cries wolf on a string method is one people learn to ignore, which is worse
than not having it.

Its `--self-test` case runs the **same** `scanSource()` function the real walk
uses, against one violating source and one clean one, and fails if either the
real spawn goes undetected or the string method is flagged. A self-test with its
own copy of the regex would prove nothing about the regex that actually runs.

**`repo-hygiene`** — passes when the dependency list is exactly the approved one,
the reproducibility files exist, and nothing forbidden is staged. Fails on an
unapproved dependency; a missing `package.json`, `package-lock.json` or
`.node-version`; an `engines.node` range that admits another major; or a staged
database or audit path.

**`secrets`** — passes when gitleaks reports nothing (required mode). Fails on a
finding, or, in required mode, when gitleaks is unavailable. gitleaks is now
installed, so the required gate produces a real verdict rather than a refusal;
see §3a for the two historical findings it produced on the first run and the
narrow ignore entries that cover them.

Three of these are worth explaining, because they are the ones that could be
mistaken for ceremony:

**`layout` and the designated evidence directory.** The check walks the tree but
skips `.git`, `node_modules`, `.lain-audit` and `artifacts`. The audit tree is the
user's evidence, 142 MB of benchmark databases, protected by `.gitignore`;
`artifacts/` is where this build writes its own logs, and a check must not fail on
its own output. Both exclusions are explicit and commented.

**`format` scope.** The policy is enforced on files this repository owns (`src/`,
`test/`, `tools/`, `docs/implementation/`, and named root files). The canonical
documents and `docs/research/` are *reported* but not enforced, because they
predate the policy and four of them are CRLF in the working tree under
`core.autocrlf=true`. `npm run check:format-strict` turns those into failures for
when the repository has been renormalised — see `open-issues.md` issue 1.

**`tests` and the zero-test case.** A suite that runs nothing exits 0. This check
treats a zero test count as a failure, and its self-test proves that a failing
test produces a non-zero exit and a `fail` counter.

## 3. Dependencies

- **Runtime:** none, ever, without an explicit project decision. Currently none
  (`dependencies: {}`).
- **Development:** minimal, pinned, justified individually. Currently
  `typescript` 7.0.2 (type checker) and `@types/node` ^24.19.2 (Node API
  declarations).
- **System tools:** optional; absence is reported, never hidden. `gitleaks` **8.30.1**
  is now installed (`Gitleaks.Gitleaks` via `winget`, at
  `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gitleaks.Gitleaks_…\gitleaks.exe`, linked
  onto PATH by winget).

`typescript` is used only through `tsc --noEmit`. The source files are `.mjs` with
JSDoc types, so the runtime artifact is exactly the file Node executes and no
build step exists. `@types/node` was added because the type checker cannot see
`node:fs`, `node:sqlite` and the rest without it: without the declarations the
types check would be checking almost nothing while reporting success, which is
worse than not having it.

`tools/check/repo-hygiene.mjs` holds the approved list
(`ALLOWED_RUNTIME_DEPENDENCIES`, `ALLOWED_DEV_DEPENDENCIES`) and fails when the
installed set differs. Adding a dependency is therefore a deliberate edit to the
policy, not an accident of `npm install`.

## 3a. The secret scanner, once it existed

Installing gitleaks changed the gate from a red light into a working detector, and
it immediately found two leaks. **Both were on `test/store/redaction.test.mjs:70`
in commit `e01dbb2`** — the synthetic JWT fixture for the test that proves
secrets do not reach the store. The story is worth keeping, because the first
attempt at hiding it was a defence that looked correct and was not.

The M-1 author stored the fixtures as base64 blobs and decoded them at runtime, so
the file would contain no secret text. It contains no secret text. gitleaks found
it anyway: its `jwt-base64` rule **decodes a base64 blob before matching**. The
defence assumed a scanner that reads text, and the real one decodes. The current
tree now builds the token from its three segments at runtime — same 123-character
token, no base64 or base64url string anywhere in the file — and the store still
redacts it as `redacted:jwt`.

History still holds the old blob, and `gitleaks detect` scans commits rather than
the working tree, so the finding outlives the fix. Rewriting published history is
not something this project does without permission, so `.gitleaksignore` carries
**exactly two fingerprints**:

```
e01dbb2e6b2faa3e8e66c9939f043940901e1231:test/store/redaction.test.mjs:jwt-base64:70
e01dbb2e6b2faa3e8e66c9939f043940901e1231:test/store/redaction.test.mjs:jwt:70
```

The file names two findings rather than a path or a rule, so a real secret added
to that file or any other does not match it; and if the fixture line changes the
fingerprints stop matching and the finding comes back, which is the correct
failure, because then nobody has read it.

**What this does not prove.** gitleaks' rule set is a detector, not a proof. It
did not see the real leak because it did not exist; it saw a synthetic one because
the fixture is shaped like the thing it detects. A clean scan means "no known
pattern matched", and the report says exactly that.


## 4. Runtime and the SQLite API

`node:sqlite` ships with Node 24 and is **stable**, not experimental: importing
it emits no warning, and it exposes `DatabaseSync`, `StatementSync`, `Session`,
`constants` and `backup`. The embedded SQLite version on this machine is
**3.53.4**, recorded by the `runtime` check on every run.

A file-based probe established the three facts M-1 Step 2 depends on: WAL mode
applies to a file database (`pragma journal_mode=WAL` returns `wal`), the default
`synchronous` level is `2` (FULL), and a transaction that fails leaves previously
committed rows intact while a committed batch is readable after reopening.

The in-memory case is a trap worth recording: `pragma journal_mode=WAL` on a
`:memory:` database returns `memory`, because WAL is a property of a file-backed
database. A probe that used `:memory:` would have concluded, wrongly, that WAL
was unavailable.

## 5. What this system does **not** prove

- It does not prove the event store is correct; the store is not implemented.
- It does not prove containment. `--require-security` proves only that the secret
  scanner ran. Execution containment is unimplemented and unmeasured in code.
- It does not prove the tests are meaningful beyond the properties they assert.
  The meta-test in `test/tools/verification-meta.test.mjs` proves the *checks* can
  fail; it cannot prove a test asserts the right thing.
- It does not scan history. The fallback pattern scan reads the working tree; the
  gitleaks gate, when available, is what reads history.
- It does not measure performance. No check here has a timing threshold, and none
  should until a baseline measurement exists.
