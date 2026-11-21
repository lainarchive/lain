# Verification pipeline

**Scope:** every change, by any agent or person. Two passes, then pre-flight, then review. A pass is not skipped because
the change looks small; it is shorter.

## 1. Pass one: plan and architecture review

Done before any implementation file is edited.

1. **Verify the starting state.** Branch, `git status`, `docs/memory/CURRENT_STATE.md`, and the decisions in `DECISIONS.md`
   the change touches (`AGENTS.md`, session-start verification).
2. **Trace the work.** Name the task, issue or spec it implements (`.devin/efficiency.md`, section 4). No trace, no plan.
3. **Write the plan.** In the PR description draft or the task response, at most one screen:
   - Objective, and the acceptance criteria that prove it.
   - Files and modules to change; contracts, schemas or reason codes affected.
   - Decisions it depends on, with their status. A Proposed or Experiment-required ADR is not settled.
   - Risks: security boundary, policy, cost, data migration, containment wording (`SECURITY_MODEL.md` section 10).
   - The verification plan: which gates in section 3, which new tests, which measurements.
4. **Review gate.**
   - **Owner approval required before pass two** when the plan adds a dependency or crate, changes a public contract or
     reason code, touches the Policy Engine, store ownership, containment or spend controls, or records or relies on a
     decision that is not Accepted.
   - Otherwise the plan is posted and pass two proceeds. The reviewer can still reject at section 4.

## 2. Pass two: implementation

- Implement the approved plan and nothing else. A discovery that changes the plan stops the pass: update the plan and
  re-enter the review gate if section 1.4 now applies.
- Follow `docs/implementation/code-style.md`, `.devin/rust_core.md` for Rust, `.devin/frontend.md` for any interface.
- Tests land in the same change as the code they cover:
  - **Unit tests** for every new function with a branch, and a failing-first test for every bug fix.
  - **Integration tests** for every change that crosses a boundary: store, Policy Engine, workspace, CLI, provider
    transport, event bus.
  - Default tests cost $0 and make zero network calls. Live transports stay behind `ALLOW_LIVE=1` and `OPENAI_FUNDED=1`.
- Commit in small, conventional commits as you go (`.devin/efficiency.md`, section 5).

## 3. Pre-flight checks

Run locally before marking ready for review. Every gate that applies must pass; report each with its actual result line.

| Area | Gate | Pass condition |
| --- | --- | --- |
| Node: types | `node tools/check/types.mjs` | 0 diagnostics |
| Node: tests | `npm test` | all pass, non-zero count |
| Node: full gate | `npm run verify` | `checks=8 pass=8 fail=0`, gitleaks included |
| Node: gate self-test | `npm run check:self` | every check proves it can fail; run when `tools/check/` changes |
| Rust: format | `cargo fmt --all --check` | no diff |
| Rust: lint | `cargo clippy --workspace --all-targets -- -D warnings` | no warnings |
| Rust: tests | `cargo test --workspace` | all pass |
| Hygiene | `git status -s` | no stray `.db`, `.log`, `.tmp` or `artifacts/` paths staged |

Rust rows apply once a Cargo workspace exists. Node rows apply while Node code exists. `npm run verify` already covers
format (F-1 to F-6), layout, store and process boundaries, dependency hygiene and the secret scan.

**Coverage.** Every change shows that its new code is exercised:

- Node: `node --test --experimental-test-coverage "test/**/*.test.mjs"` and quote the line, branch and function
  percentages for the changed files. Use the quoted glob; a bare `node --test` picks up `test/helpers/store-child.mjs`,
  which fails on purpose.
- Rust: `cargo llvm-cov --workspace` once the owner approves the tool.
- Coverage is reported per change, not gated on a repository-wide threshold, until the owner sets one. A drop in coverage
  for the changed files is explained in the PR.

## 4. Ready for review

A change is ready for review only when:

- Pass one's plan is in the PR and, where section 1.4 applies, approved.
- Every applicable pre-flight gate passed, with result lines in the PR (`.devin/efficiency.md`, section 6).
- New and changed behaviour has tests, and coverage for the changed files is reported.
- `docs/memory/CURRENT_STATE.md` or `docs/implementation/` is updated when the change alters what is true about the system.
- Remaining issues are recorded in `docs/implementation/open-issues.md`, not left in the PR thread.

A failed gate is fixed, not explained away. If a gate cannot run (tool absent, platform mismatch), the PR says which gate,
why, and what was run instead; an absent gate is never reported as a pass.

## 5. Merge and handoff

- No push to `main` and no merge without explicit owner permission. Never rewrite published history.
- After merge, the session that did the work leaves a handoff in the established location (`AGENTS.md`, handoffs).
