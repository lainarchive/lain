# 04 — Build and Verification System

**Status:** Proposal. **No dependency was installed, no build was run, and no command in this document has been executed** (the repository has no package manifest, no source tree, and no build command — Phase 4 G-2). Everything labelled **UNVERIFIED** below is a proposal whose execution is part of step 1 of the implementation sequence.
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Labels:** EUR · EAD · ESR · UAP · OQ · SESS (measured this session) · UNVERIFIED (not executed).

---

## 1. Requirements this system must meet (ESR)

1. **Reproducible from a clean checkout with one documented command** — today AT-001 ("repository builds") has no meaning because no build command exists.
2. **$0 and no paid tooling** (EUR).
3. **Minimal dependencies** (EUR, constraint 6). Every added package is a liability in the most security-relevant code path.
4. **Works on Windows 11 without elevation** (EUR; the machine has Developer Mode on but the runtime must not require admin).
5. **Local-first**: no network access required to build, test or verify (EUR).
6. **Checkable by a machine**, because "nothing is done until a command proved it" (EUR).
7. **Reports failures loudly** — a check that cannot fail is the defect the audit found in the acceptance suite, so every check here must be demonstrably able to fail (a positive control).
8. **Cheap enough to run on every change** on 4 cores.

## 2. Toolchain: what is already present (SESS)

| Tool | Version measured | Status |
|---|---|---|
| `node` | **v24.21.0** | present; supplies the runtime, `node --test`, and `node:sqlite` |
| `npm` | ships with Node | present (bundler/runner only) |
| `python` | **3.15.0** | present; available for scratch tooling, not proposed as a build dependency |
| `git` | **2.56.0.windows.2** | present |
| `cargo` / `rustc` | **absent** | Rust is not a v0.1 candidate for this reason among others |
| `pnpm` | not verified as installed in this session | **not required** by this proposal |
| `ollama` | client 0.40.4, **no daemon listening** | irrelevant to M-1 (no model calls) |

## 3. Alternatives compared (ESR)

| Option | Windows | Resource cost | Dependency count | Local-first | Maintainability | Security | Verdict |
|---|---|---|---|---|---|---|---|
| **Node 24 + `node --test` + `node:sqlite`, no third-party runtime deps** | native | 1 runtime already installed | **0** runtime deps | yes | small codebase, one language | smallest surface; no postinstall scripts, no native build | **Recommended** |
| Node + `pnpm` + `vitest` + `eslint` + `prettier` + `better-sqlite3` | native | more (test transform, native addon, ~10⁵ files) | ~5–8 direct, hundreds transitive | yes but networked install | familiar, plugin-rich | large supply-chain surface; native addon ABI churn | Rejected for M-1 |
| Python + `pytest` + stdlib `sqlite3` | native | 1 runtime present | 1–2 (pytest) | yes | good | good; but the Core language decision (OD-1) points to TypeScript | Rejected (contradicts OD-1 recommendation) |
| Rust + `cargo test` | native | compiles | many crates | yes | strong typing | strong | Rejected: toolchain absent; contradicts OD-1's "TS now, hybrid preserved" |
| Make/`just` + shell only | needs a shell | minimal | 0 | yes | brittle string handling | fine | Rejected as the *primary* mechanism (poor Windows ergonomics), acceptable later as a thin wrapper |

**ESR — why Node 24 with zero runtime dependencies.** It is the only option that satisfies all eight requirements with **no install step at all**: `node:sqlite` removes the database dependency, `node --test` removes the test-runner dependency, and Node 24's own TypeScript support removes the transpiler dependency. The trade is fewer conveniences; the gain is that the entire dependency tree of the most security-relevant component is the Node runtime itself, which is auditable and already trusted by the machine.

## 4. The proposed checks, and exactly what each may add

| # | Check | Mechanism | Dependencies | Status |
|---|---|---|---|---|
| V-1 | **Build / load** | `node --check` per file, plus a real import of every module | none | UNVERIFIED |
| V-2 | **Type check** | `tsc --noEmit` **or** Node 24's built-in type stripping with no separate check | `typescript` (**1 dev dependency**) or none | **OQ-M1.15** — see §5 |
| V-3 | **Tests** | `node --test` (TAP output) | none | UNVERIFIED |
| V-4 | **Unit → integration → recovery** in that order, same runner, different directories | none beyond V-3 | UNVERIFIED |
| V-5 | **Format / lint** | **Biome** (single tool, single dependency) | `@biomejs/biome` (**1 dev dependency**) | **OQ-M1.16** |
| V-6 | **Security check (dependency surface)** | assert the dependency count has not grown: compare `package.json` deps against a recorded allow-list and **fail on any addition** | none | UNVERIFIED |
| V-7 | **Secret scan** | run `gitleaks` **if present**; if absent, the check reports `SKIPPED` **and fails in CI mode** (a skipped security check must not look like a pass — EUR) | external, optional | UNVERIFIED |
| V-8 | **Policy-bypass check** | assert that no module outside `store/` opens the store file, and that the redaction filter is invoked on every append path | none | UNVERIFIED |
| V-9 | **Docs check** | every canonical document exists, is non-empty, and every referenced path in `AGENTS.md`/`README.md` resolves | none | UNVERIFIED |
| V-10 | **Acceptance results retained** | each run writes raw output to `artifacts/verify/<timestamp>/` with the command, exit code and machine probe | none | UNVERIFIED |

**ESR — V-6 and V-8 are the two checks specific to this project.** V-6 makes "minimal dependencies" a rule rather than a value (audit G-6); V-8 turns "security enforced outside the model" into something a machine checks, because redaction-bypass is precisely the class of defect that survives review.

## 5. The proposed commands (UNVERIFIED — to be executed as step 1 of the sequence)

```jsonc
// package.json (proposed, NOT created)
{
  "name": "lain",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "check":   "node --run check:load && node --run test && node --run check:security && node --run check:docs",
    "check:load": "node scripts/check-load.mjs",
    "test":    "node --test test/unit test/integration test/recovery",
    "test:one":"node --test",
    "check:security": "node scripts/check-deps.mjs && node scripts/check-store-boundary.mjs",
    "check:docs": "node scripts/check-docs.mjs",
    "probe":   "node scripts/probe-host.mjs"
  }
}
```

- **The single entry point is `npm run check`.** One command, exit code 0 or not, plus retained raw output. That is what makes AT-001 meaningful.
- `node --run <script>` executes a `package.json` script without a package manager in the loop. **UNVERIFIED on this Node build** — if it misbehaves, the fallback is `npm run`, which requires no install either.
- **No `postinstall`, no native compilation, no network access** at any check.

**ESR — the type-check decision (OQ-M1.15).** Two honest options:
- **(a) No TypeScript at all in M-1** — plain ESM JavaScript with JSDoc types, checked by nothing. Zero dependencies, weakest static guarantees.
- **(b) TypeScript with `tsc --noEmit`** — one dev dependency, real static checking, and the code is `.ts` compiled by Node's own stripping at run time.
**Recommendation (ESR, UAP): (b)**, because the store's correctness depends on shapes that a test can only partially cover, and one dev dependency is the smallest possible price. **This is a user decision** because it adds the first dependency to a repository that has none.

## 6. Reproducibility rules (ESR)

1. **No floating versions.** All dependencies pinned to exact versions; the lockfile committed once a manifest exists.
2. **`engines.node` enforced** — the build refuses on an older runtime rather than producing subtly different behaviour.
3. **The machine probe is recorded with every verification run** (hardware, OS build, tool versions, timestamp) so a result can be attributed to an environment — the audit's GPU figure moved 2.8 GB between sessions, so environment drift is a first-class concern.
4. **Tests must not depend on wall-clock time, network, or model availability.** M-1 has zero model calls; any test that needs one is misclassified.
5. **A skipped check is a failure in verification mode** (V-7's rule) — this is the single most important anti-vacuity rule in the whole system.

## 7. Test-result reporting and the harness the Phases 5–8 tests inherit (ESR)

The audit found that all 57 Phase 5–8 acceptance tests specify thresholds but none specifies a runner (F-M1-5). M-1 fixes that by defining the harness once:

```
test/fixtures/<test-id>/            input files, expected outputs
test/unit|integration|recovery/     test files named <test-id>.test.mjs
artifacts/verify/<timestamp>/       raw runner output, exit code, host probe, per-test line
```

Each acceptance test in `05-event-store-acceptance-tests.md` names its **test ID**, so the artifact layout makes "which test produced this evidence" answerable by path. A test that cannot be run (e.g. power-loss) is reported as **NOT-TESTABLE** with a stated reason, never as passing.

## 8. Acceptance criteria for the build system itself (ESR)

| ID | Criterion | Threshold |
|---|---|---|
| BV-01 | One command runs every check | `npm run check` exits 0 on a clean checkout with **no network access** |
| BV-02 | The command can fail | a deliberately broken file makes `check:load` exit non-zero (**positive control**) |
| BV-03 | Tests can fail | a deliberately failing assertion makes `npm test` exit non-zero |
| BV-04 | Dependency growth is blocked | adding any dependency not in the allow-list makes `check:security` exit non-zero |
| BV-05 | Store boundary is enforced | a module outside `store/` that opens the store makes `check-store-boundary` exit non-zero |
| BV-06 | Skipped security check is not a pass | with `gitleaks` absent, verification mode exits non-zero |
| BV-07 | Docs references resolve | a renamed referenced file makes `check:docs` exit non-zero |
| BV-08 | Results are retained | every run leaves a timestamped artifact directory containing command, exit code and probe |
| BV-09 | Runtime is pinned | running under a Node version below `engines` refuses with a clear message |
| BV-10 | No elevation required | the whole suite runs without an administrator token (measured by the probe's integrity level) |

## 9. Open questions

| # | Question | Blocks |
|---|---|---|
| OQ-M1.15 | TypeScript with one dev dependency (recommended), or zero-dependency JavaScript? | the first dependency in the repository |
| OQ-M1.16 | Format/lint: Biome (one dependency, recommended), or nothing until the codebase justifies it? | developer ergonomics vs dependency count |
| OQ-M1.17 | Is `gitleaks` installed, or is the secret scan deferred with an explicit "not run" record? | V-7's behaviour |
| OQ-M1.18 | Is a package manager beyond `npm` wanted for later phases (pnpm is in the owner's default stack), given M-1 needs none? | M-2+ tooling |
