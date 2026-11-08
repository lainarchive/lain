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

**`repo-hygiene`** — passes when the dependency list is exactly the approved one,
the reproducibility files exist, and nothing forbidden is staged. Fails on an
unapproved dependency; a missing `package.json`, `package-lock.json` or
`.node-version`; an `engines.node` range that admits another major; or a staged
database or audit path.

**`secrets`** — passes when gitleaks reports nothing (required mode). Fails on a
finding, or, in required mode, when gitleaks is unavailable.

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
- **System tools:** optional; absence is reported, never hidden. Currently
  `gitleaks`, which is **not installed**.

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

**gitleaks is not installed and this build does not install it.** That is the
project owner's call. Until it is present, `npm run verify` fails, and the final
report of any milestone must say "the secret scanner was unavailable", not "no
secrets found".

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
