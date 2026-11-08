# 00 — Readiness Audit of the Phase 4–8 Research Package

**Status:** Research finding register. **Read-only audit; no existing research file was modified.**
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Labels:** EUR · EAD · ESR · UAP · OQ · HIST (historical measurement, not re-executed) · SESS (measured this session).

---

## 1. Method and scope

**SESS — what was actually inspected.** The canonical repository was verified (HEAD `36a3e18`, branch `main`, 11 commits, 13 tracked files, 0 staged, 0 modified tracked, 0 implementation files matching `*.ts|*.js|*.mjs|*.rs|*.py|*.go|*.json|*.toml|*.cs` outside `.git` and `.lain-audit`), then all 13 new research documents were enumerated with byte and line counts (196 111 B total) and subjected to six mechanical cross-checks, plus targeted content review of the phase-4 audit, the phase-5 specification's substrate table, and the cross-phase document. The canonical documents were read for consistency only and were **not modified**.

**SESS — mechanical cross-checks run, with results:**

| Check | Command shape | Result |
|---|---|---|
| Unresolved markers | `TBD\|TODO\|XXX\|FIXME\|placeholder\|to be determined` over the 13 docs | **0 hits** |
| Relative-link resolution | `\]\((\.\.?/[^)]+)\)` extraction + `Test-Path` per target | **0 relative markdown links exist** → 0 broken, and 0 checkable (see F-M1-1) |
| Claim-class labels | per-file counts of `EUR/EAD/ESR/UAP/OQ` | present in 11 of 13; **absent in 2** (see F-M1-2) |
| False "existing infrastructure" assertions | `uses the existing\|the existing (Policy Engine\|Capability Registry\|extension contracts\|event (store\|log))` | **3 hits, all correct in context** — 2 quote `ARCHITECTURE.md` as a *finding*, 1 says "Reuses the existing approval machinery… instead of a parallel one" (an instruction not to duplicate, not a claim of existence) |
| Cross-document numeric consistency | `concurrent\|in flight\|ceiling` sweep | **consistent** — 1 model call, `min(4, cores−1)=3` tool subprocesses, 4 live task agents, depth 2, repeated identically in phase 5 §3.2, phase 7 and the cross-phase document |
| Policy-engine references | `decide\(\)` count per file | 11 hits across 5 files, **all** in dependency/blocked-by context with the "no implementation" caveat |

---

## 2. Verification against the ten required criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | All documents exist and are readable | **PASS** | 13 files enumerated with sizes; 0 read failures |
| 2 | Internal references resolve | **PASS with caveat** | 0 broken links; but no relative links exist, so resolution is untested by construction (F-M1-1) |
| 3 | Requirements and acceptance tests consistent | **PASS** | AT-5.01–15, AT-6.01–15, AT-7.01–15, AT-8.01–12: no duplicate IDs, no gaps in numbering, tiers M/D/P applied consistently, positive controls required for every denial class |
| 4 | Claims have appropriate evidence | **PASS with 3 exceptions** | Every measured figure cites `20-p0-preparation.md` §6 or `21-p0-e3-e5-results.md`; exceptions listed in §3 (F-M1-3) |
| 5 | Proposed architecture is not presented as accepted | **PASS** | Status lines present in all 13; `DECISIONS.md` untouched; UAP labels used where an imported proposal is unapproved |
| 6 | Historical measurements are not presented as universal guarantees | **PASS** | All hardware figures carry the audit's date; phase 7 states the historical profile is a starting reference requiring re-measurement; phase 5 §1.1 re-measures this session |
| 7 | No phase assumes nonexistent infrastructure | **PASS** | Every phase carries an explicit dependency table with an "Exists? No" column; the cross-phase document states outright that no subsystem can be honestly implemented today |
| 8 | Cross-phase dependencies consistent | **PASS** | The six shared primitives are named identically in the cross-phase doc, phase 5 §11 and phase 8 §6; no phase claims a primitive another phase says is missing |
| 9 | Security requirements do not depend on model obedience | **PASS** | Phase 6 rules 1–10 are enforcement-side; Phase 5's admission/immutability is structural; Phase 8's refusals are "structural refusals with no configuration flag"; no requirement is phrased as something the model must refrain from |
| 10 | Phase 4 findings accurately represented | **PASS** | The Phase 5–8 documents cite F-1.1/F-1.2/F-1.4/F-2.3/F-4.3 by ID and describe them consistently with the source audit; the one wording risk is noted in F-M1-4 |

---

## 3. Findings register

### F-M1-1 — No relative document links exist, so reference integrity is unverified by construction
**Severity: LOW.** **CLASS: ESR.**
**Evidence (SESS).** A scan for `](relative/path.md)` across the 13 documents returns **zero matches**; cross-document references are written as bare filenames in prose or backticks (e.g. the M-1 README table uses `` `01-event-store-specification.md` ``). The intent is clear to a human, and every referenced file does exist, but a reader (or a link checker) cannot resolve them mechanically.
**Recommended correction.** In a future research-maintenance pass, convert filenames in the document tables to relative markdown links. **Not corrected now** — the brief forbids modifying existing research files, and this is cosmetic.

### F-M1-2 — Two documents carry no claim-class labels
**Severity: LOW.** **CLASS: ESR.**
**Evidence (SESS).** `docs/research/phase-5-agents-orchestration/README.md` (0/0/0/0/0) and `docs/research/implementation-readiness/cross-phase-dependencies-and-sequence.md` (EUR 0, EAD 0, UAP 0) label claims inconsistently with the convention used everywhere else; the cross-phase document does use ESR and OQ.
**Recommended correction.** Add the label convention to both READMEs in a future pass; the substantive specifications they summarize **are** labelled.

### F-M1-3 — Three figures are stated without a primary-source citation
**Severity: MEDIUM.** **CLASS: UNV (unsupported as written).**
**Evidence.** (a) Phase 5 §3.2 gives tool-subprocess concurrency as `min(4, cores − 1) = 3` with the rationale "reserve one core for Core/UI so cancellation stays responsive" — the formula is a *design rule*, not a measurement, and is presented in a table whose other rows cite measurements. (b) Phase 7's "~10 GB committed" RAM figure appears without a timestamped source in the companion document. (c) Phase 8's statement that publishing into the Godot asset ecosystem is "$0" is the user's own constraint applied, not an observed fee schedule.
**Recommended correction.** Restate (a) explicitly as a **derived design rule (D)**, not a measurement, and specify the measurement procedure that would replace it (see `03-resource-budget-specification.md` §6). Timestamp (b) or mark it UNV. Verify (c) against the store's current terms before any listing is published — it is a platform claim with a real cost if wrong.

### F-M1-4 — One Phase 4 finding is summarized in a way that could be read as an accepted decision
**Severity: MEDIUM.** **CLASS: UAP (risk of misreading).**
**Evidence.** Phase 6 §2 renders the auto-activation clause as a settled position in some passages ("low-risk, validated declarative extensions… may be installed and activated automatically"), whereas the Phase 4 audit classes it **UAP** and lists the three undefined terms. The M-1 package does not treat it as decided, and Phase 6's own status line says nothing here is accepted — but a reader skimming Phase 6 alone could take the clause as policy.
**Recommended correction.** In the eventual canonical edit (C-7), the clause must be rewritten to define "low-risk", "validated" and "declarative" **or** removed; until then, treat the clause as unapproved. Recorded in `08-open-decisions.md` as OQ-M1.5.

### F-M1-5 — Acceptance tests are well-formed but no test has an execution harness specified
**Severity: MEDIUM.** **CLASS: ESR.**
**Evidence.** All 57 acceptance tests across the four phases specify thresholds and tiers; none specifies *how the test is driven* (a runner, a fixture format, where raw results are retained). `ACCEPTANCE_TESTS.md` in the canonical repository has the same gap, and the phase-7 Evaluation Lab correctly demands a reproducibility record — so the requirement exists in one place and the mechanics in none.
**Recommended correction.** `04-build-and-verification-system.md` §7 specifies the minimal harness (fixture files, a runner, retained raw output) for M-1; the Phase 5–8 tests inherit it when their subsystems exist.

### F-M1-6 — The research package is entirely untracked, which is itself a provenance risk
**Severity: HIGH (operational).** **CLASS: ESR.**
**Evidence (SESS).** `git status --porcelain` shows the six research directories untracked; W (the consolidation backup) predates them; V predates them. **196 111 B of analysis exists in exactly one place on one disk**, and Phase 4's own finding F-1.3 was that the Stage 6 source sits outside the repository and outside every backup.
**Recommended correction.** Commit the research package (with the user's authorization) and re-run the backup before implementing M-1. This finding is the same class of risk the audit raised about the Stage 6 file, now applying to the audit's own output.

### F-M1-7 — No finding was contradicted; the package is internally coherent
**Severity: INFORMATIONAL.** **CLASS: ESR (positive result).**
**Evidence.** The six mechanical cross-checks and the ten-criterion review found no contradiction between phases, no assumption of nonexistent infrastructure, and no security requirement that depends on model obedience. The defects above are presentation and provenance issues, not design conflicts. **This is the strongest statement the audit supports: the research package is fit to build from, subject to F-M1-6 and the open decisions.**

---

## 4. What this audit did not do

**ESR.** It did not verify the *truth* of the historical `.lain-audit` measurements (that is `02-security-and-containment.md`'s job for C-1/C-2, and it is a documentary review, not a re-execution). It did not re-derive the Phase 5–8 designs. It did not modify any file. It did not run the acceptance tests — **no test in this package has been executed, because the system they test does not exist.** Any statement to the contrary would be the exact failure this project's constraints forbid.
