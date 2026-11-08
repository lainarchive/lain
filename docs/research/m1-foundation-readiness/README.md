# M-1 Foundation Readiness — Overview

**Status:** Research and proposed specification. **Nothing here is an accepted decision, and nothing here has been implemented.**
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c` (`main`, 11 commits, 13 tracked files, no implementation source tree)
**Authorized scope of this package:** read and document only — no code, no canonical-document edits, no Git operations, no dependency installation. The only files created are the ten documents in this directory.
**Claim labels used throughout:** **EUR** explicit user requirement · **EAD** existing accepted decision · **ESR** evidence-supported recommendation · **UAP** unapproved proposal · **OQ** open question · **HIST** historical measurement from `.lain-audit` (not re-executed) · **SESS** measured in this session.

## Why this package exists

The program brief for Phases 5–8 ended with a verdict: **no subsystem in the four-phase program can be honestly implemented today**, because they all depend on the same small set of missing primitives. This package turns that verdict into something buildable — a measurable specification for **M-1: Lain Foundation**, which is the first milestone where Lain stops being documents and starts being a system that can prove things about itself.

The organizing principle is the one the audit established and this package keeps: **a claim that cannot be checked is not a foundation.** Every threshold below is either measured on this machine (**M**), derived from a measurement by a stated rule (**D**), or explicitly proposed and marked as needing a measurement before it gates anything (**P**).

## Documents

| File | Delivers | Corresponds to |
|---|---|---|
| `00-readiness-audit.md` | audit of the 13 Phase 4–8 research documents against ten verification criteria; findings register with severity and recommended correction | brief §2 |
| `01-event-store-specification.md` | the complete implementation-ready event-store specification: data model, write/read guarantees, security, recovery, operations, storage comparison, Windows-achievable ceiling | brief §7 |
| `02-security-and-containment.md` | C-1 event-store integrity (what the 963/1766 measurement does and does not prove) and C-2 the verified containment ceiling, with proposed corrected security language | brief §3 (partly), §4 |
| `03-resource-budget-specification.md` | proposed `RESOURCE_BUDGET.md` content: measurements, workloads, configured limits, defaults, unverified estimates, discovery mechanism | brief §5 |
| `04-build-and-verification-system.md` | the smallest reproducible build/check system, toolchain comparison, exact commands, measurable acceptance criteria | brief §6 |
| `05-event-store-acceptance-tests.md` | the acceptance-test specification for the event store: ID, preconditions, procedure, expected result, failure conditions, retained evidence | brief §8 |
| `06-one-bounded-agent-specification.md` | `Lain v0.1.0 — One Bounded Agent`: component interfaces, contracts, state transitions, cancellation, failure handling, event requirements | brief §9 |
| `07-implementation-sequence.md` | the ordered engineering plan with objective, prerequisites, files, acceptance criteria, tests, risks, rollback and decision gates | brief §11 |
| `08-open-decisions.md` | the unresolved decisions, each with options, a recommendation labelled as such, and what it blocks | brief §12 |

**Event-store ownership** (brief §3) is analysed in `02-security-and-containment.md` §1, as a comparison of four viable ownership models with a labelled recommendation. **No canonical ownership table was modified, and no owner was invented as accepted.**

## The single most important statement in this package

**Nothing in M-1 requires a model call.** The event store, the policy decision contract, the resource budget, the build/check system and the task contract are all deterministic, testable, and independent of any language model. That is deliberate: it means M-1 can be verified completely, on this machine, with no GPU, no provider, and no network — and it means that when the model loop is added in M-2, the parts underneath it are already proven rather than assumed.

## Dependencies of this package

- `.lain-audit/20-p0-preparation.md` §5 (state of the experiments) and `21-p0-e3-e5-results.md` (E3/E5 results) — **read-only source of HIST figures**
- `docs/research/phase-4-documentation-audit/00-documentation-audit.md` — findings F-1.x … F-5.x, corrections C-1…C-10
- `docs/research/phase-5…8/…` — the specifications this milestone must serve
- `docs/research/implementation-readiness/cross-phase-dependencies-and-sequence.md` — the dependency matrix this package makes concrete
- `AGENTS.md`, `SYSTEM_BOUNDARIES.md`, `SECURITY_MODEL.md`, `DECISIONS.md`, `IMPLEMENTATION_ROADMAP.md`, `INITIAL_BACKLOG.md`, `ACCEPTANCE_TESTS.md`, `docs/memory/CURRENT_STATE.md` — canonical context, **unmodified**

## What was actually verified about *this* package (SESS)

After the ten documents were written, the package itself was measured — not assumed:

| Check | Result |
|---|---|
| File inventory | **10 files, 122 424 B** (`README.md` 5 283; `00` 10 473; `01` 19 234; `02` 19 294; `03` 8 671; `04` 11 214; `05` 13 114; `06` 13 775; `07` 9 514; `08` 11 852) |
| Unresolved markers (`TBD`, `TODO`, `XXX`, `FIXME`, `to be determined`) | **0 occurrences** — the single hit in a scan of the package is the scan's own regex written into a results table in `00-readiness-audit.md:17`, not a placeholder |
| Per-document required elements | "Status" present in **10 of 10**; an Evidence section in 9 of 10; Dependencies in 8 of 10; Security in 10 of 10; an Open Questions section in 8 of 10 |
| Cross-references *between package documents* (`NN-….md` style) | **all resolve** |
| Cross-references to `.lain-audit/` sources written in shorthand (`20-p0-preparation.md`, `21-p0-e3-e5-results.md`) | **do not resolve as written** — they exist at `.lain-audit/` and are cited correctly in the Dependencies list above; see F-M1-7 |
| Repository state after authoring | HEAD still `36a3e18003ad41171be96d28cfbbda5b5304441c`, 11 commits, **0 staged, 0 modified tracked, 0 canonical documents touched**, `VISION.md` not created, `RESOURCE_BUDGET.md` not created |
| Protected locations | B still at `0e7fdee`; `.lain-audit` still 144 files |
| Tests, benchmarks, model calls | **none run** — no implementation exists to run them against |

**F-M1-7 (NEW, minor, documentation):** five citations inside this package name audit artefacts in shorthand, which a reader following them from the repository root would not resolve. Nothing is wrong with the sources — the fix is to write them as `.lain-audit/…` paths, and it is recorded here rather than silently applied, per the brief's instruction not to modify existing research files.

## Open questions owned by this package

See `08-open-decisions.md`. The three that block implementation soonest: **OQ-M1.1** event-store ownership model; **OQ-M1.2** Windows-only v0.1; **OQ-M1.3** whether toolchain processes may run in the low-integrity workspace (the containment boundary decision).
