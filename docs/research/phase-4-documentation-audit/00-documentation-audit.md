# Phase 4 — Documentation Integrity and Architecture Reconciliation Audit

**Audited revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Status:** Complete. Read-only. Every correction is a proposal.
**Predecessor:** `.lain-audit/13-documentation-reconciliation.md` (historical input, outside the repository).

---

## 0. What this audit is and is not

This audit answers one question: **does the repository, as it stands at `36a3e18`, state things that are false, unowned, unfalsifiable, or unsupported — and if so, what exactly is wrong and what is the minimal correction?**

It is not a re-audit of the recovered conversation, and it does not re-litigate decisions that are already Accepted in `DECISIONS.md`. Where a document is vague but not wrong, that is recorded as an open question rather than a defect.

**Three failure modes are treated as defects, because each one causes incorrect implementation:**

1. **A claim whose stated basis is not in the repository.** A reader cannot verify it, and the basis can disappear (it already has, once — see F-1.3).
2. **A capability asserted as existing infrastructure.** It causes dependent design (Phases 5–8) to be built on air.
3. **A record whose own staleness cannot be detected.** It misleads exactly the reader it exists to serve.

---

## 1. Investigation area 1 — Mods and extension-architecture claims

### F-1.1 — The Mods claim in `ARCHITECTURE.md` cites infrastructure that does not exist

**Finding.** `ARCHITECTURE.md:157` states:

> "Mods are a distinct extension component for approved interface, workspace, and bounded behavior contributions. They use the existing extension contracts, registry, lifecycle, execution isolation, and Policy Engine."

**CLASS: UNV.** Measured against the repository at `36a3e18`:

| Claimed to exist | Actual state |
|---|---|
| extension contracts | **No specification exists.** The word "Mods" occurs 11 times in the canonical tree; a mod contract, manifest schema, or trust-level definition occurs **zero** times. |
| registry | Named in `SYSTEM_BOUNDARIES.md:14` ("Tool/plugin manifests → Capability Registry") as an **owner row**, with no interface, schema, or lifecycle defined anywhere. |
| lifecycle | `DECISIONS.md` ADR-012 covers creation≠activation only. No install/activate/update/disable/remove lifecycle is specified. |
| execution isolation | `SECURITY_MODEL.md:42` promises container/VM isolation that the machine cannot run (audit S-1, unchanged). The only *verified* mechanism is low-integrity token + Mandatory Integrity Control, verified for containment of 9 of 11 escape classes, with 2 untestable. |
| Policy Engine | Named as an owner (`SYSTEM_BOUNDARIES.md:13`) and referenced by `DECISIONS.md` ADR-004. **No `decide()` contract, no arm enumeration, no failure semantics is in the repository.** |

**Why this matters.** The sentence reads as a settled integration statement. In fact every noun in it is either an undefined name or an unbuilt component. A Phase 6 implementer following `ARCHITECTURE.md` alone would build a mod loader against contracts that have never been written.

**Proposed correction (ESR).** Reword `ARCHITECTURE.md:157` to state intent and dependency rather than accomplished integration — e.g. *"Mods are proposed as a distinct extension component for interface, workspace, and bounded behaviour contributions. Their integration is **not** yet specified: it depends on the extension contract, registry, lifecycle, execution-isolation and Policy Engine work listed in Phase 6. No mod capability is available before that work exists."* The word "existing" must go; it is the load-bearing error.

### F-1.2 — ADR-012 is Accepted, but the auto-activation clarification is not

**Finding.** `DECISIONS.md` records ADR-012 (creation ≠ activation) as **Accepted**. The reconciliation layer added a section titled `## Reconciliation: low-risk extension activation` that states:

> "low-risk, validated declarative extensions limited to permissions already authorized by the user **may be installed and activated automatically**."

**CLASS: UAP** for the auto-activation policy (imported historical proposal); **EAD** for the creation≠activation separation itself.

**Three undefined terms carry the whole policy.** The repository does not define:

- **"low-risk"** — no risk taxonomy, no scoring rule, no examples;
- **"validated"** — no validation procedure, no validator identity, no evidence requirement;
- **"declarative"** — no definition of which component kinds qualify, and no statement of what a declarative extension is forbidden to do.

Worse, "permissions already authorized by the user" is evaluated **per extension**, while the only permission grant mechanism the repository describes is the approval gate in `SECURITY_MODEL.md`. Without a grant record, "already authorized" is not decidable.

**Proposed correction (ESR).** Keep ADR-012 Accepted. Demote the auto-activation clause to an explicitly unapproved proposal, and state the three definitions it needs before it could ever be accepted: a risk taxonomy, a validation requirement, and a durable permission-grant record the Policy Engine reads. Until then the safe default is the strict reading of ADR-012: **creation never activates.**

### F-1.3 — The cited Stage 6 research is outside the repository, and in a volatile location

**Finding.** `docs/research/RECOVERED_CONVERSATION_NOTES.md:26` states *"Stage 6 research defines their contracts"*, and `ARCHITECTURE.md:157` relies on that research. The research is **not in the repository**. Its only located copy is:

```
C:\Users\frick\Downloads\LAIN_Organized_Knowledge_Vault\LAIN_Organized_Knowledge_Vault\99_RAW_ARCHIVE\Rewrite Rust Tweet.txt   (26 894 B)
```

**CLASS: UNV** — and a **provenance risk**, not merely a documentation gap. `Downloads` is a volatile, user-managed location outside every backup this project maintains: it is absent from the repository, from `.lain-audit/`, from backup V, and from backup W.

**Proposed correction (ESR).** Before Phase 6 relies on any Stage 6 claim: read the file, verify each architectural assertion against it, and either (a) preserve it under `docs/research/sources/` with a hash and a provenance note, or (b) treat the claims as unsourced and re-derive them. **Either way, no Stage 6 claim may be cited as authority until it is inside the repository with a verified hash.** Preservation is a write the user must authorize.

### F-1.4 — "Mods" is a third-party product concept adopted on the strength of one exchange

**Finding.** `docs/research/sources/recovered-lain-conversation.txt:5506-5518` records that Anthropic introduced **Mods for Claude Code on 2026-10-01**, describes a mod as "a TypeScript extension that can intercept and modify Claude Code's internal events", and the assistant concludes *"I think Lain should borrow this idea and take it further."* The user's contribution is: *"look into claudes new mod system they added, looks genius."*

**CLASS: HIS** (historical proposal). It is a *borrowed idea*, not a Lain requirement. The repository now presents Mods as a first-class component of Lain's extension architecture.

**Proposed correction (ESR).** Record the provenance honestly in the Phase 6 extension taxonomy: "Mods" is a concept Lain adopted from a third-party product, the interception-based design is not verified as suitable for Lain, and the capability-interception surface it implies (modifying internal events) is a **higher** trust requirement than a normal plugin — not a lower one. This directly contradicts the "low-risk → auto-activate" framing in F-1.2, and the contradiction must be resolved by the user, not silently.

---

## 2. Investigation area 2 — Collaboration Service ownership and event boundaries

### F-2.1 — "Collaboration Service" appears nowhere but in the reconciliation layer itself

**Finding.** Exact-phrase search over the canonical tree: **2 occurrences**, both introduced by commit `01ac126`:

- `ARCHITECTURE.md:153`
- `SYSTEM_BOUNDARIES.md:71`

**CLASS: UAP.** The term appears **zero** times in `.lain-audit/` — i.e. it is not even in the imported research the reconciliation layer claims to summarize — and **zero** times in the recovered transcript. The transcript's own words for this subject are "independent review", a ChatGPT/DeepSeek handoff workflow, and the event names `review.rejected` / `decision.disputed` (`recovered-lain-conversation.txt:12670-12688`, `:13405-13414`).

So the situation is inverted from the usual one: the document whose stated job is *"each canonical record has one owner"* now names an owner that exists nowhere else in the project, while the research it supposedly derives from has been relabelled into a term of art.

**Proposed correction (ESR).** Either (a) rename to the transcript's actual subject — a **review and discussion record** set owned by an existing owner — or (b) add a definition section that states what the Collaboration Service is, why it is a service rather than a set of records, and which existing owner it is distinct from. Option (a) is smaller and does not introduce a new authority.

### F-2.2 — The collaboration owner row is in prose, not in the ownership table

**Finding.** `SYSTEM_BOUNDARIES.md:6` states the rule: *"Each canonical record has one owner."* The table at `:8-20` has **11 rows** and does **not** contain the Collaboration Service; it is introduced only in a prose section at `:69-71`.

**CLASS: UAP** (structural). The rule is stated in the table's contract and then violated 50 lines later by the same file.

**Proposed correction (ESR).** Add the row to the table, or restate the prose as derived records owned by an existing row. A rule stated in one section and broken in another is worse than no rule, because it teaches readers that the table is not authoritative.

### F-2.3 — The event log still has no owner, and the single-writer rule is absent from the repository

**Finding.** The ownership table still has **no row for events**, although events are the substrate under sessions, tasks, policy, execution, and now collaboration records too. The exact phrase "single writer" / "single-writer" occurs **zero** times in the canonical tree; all 14 occurrences are in `.lain-audit/` documents (e.g. `.lain-audit/13-documentation-reconciliation.md:37-39`, `.lain-audit/15-first-vertical-slice-revised.md:40`).

This is audit defect **D-4**, still open.

**CLASS: UNV** for the gap; and the reason it matters is **measured**, not theoretical: `.lain-audit/20-p0-preparation.md` records **963 torn reads in 1 766** under WAL with per-document commits, versus **0 in 1 212** under WAL with one transaction per batch. The repository therefore implies concurrent writers are acceptable while the only measurement available shows they are not.

**Why this is the single most blocking finding for Phases 5–8.** Phases 5–8 are all event-sourced in practice: agent lifecycle transitions, delegation handoffs, review requests, extension install/activation records, evaluation results, opportunity records. Every one of them writes to the log. With no owner and no writer rule, each phase would invent its own — which is exactly how the single-writer rule gets broken before it is written.

**Proposed correction (ESR).** Add two things and only two: one table row — *Events and event log → Event Store* (or the Session Manager, if the user prefers fewer components) — and one normative sentence: **"The event log has exactly one writer. Concurrent writers are not supported; batches are committed in one transaction. Readers use projections."**

### F-2.4 — An ownership row now asserts an interface (`decide()`) that is defined nowhere

**Finding.** The audit archive records the proposed Phase 1 shape of the policy engine as a "total `decide()` with eight explicit arms, default arm `Deny`" (`.lain-audit/15-first-vertical-slice-revised.md`). The repository names the Policy Engine as an owner (`SYSTEM_BOUNDARIES.md:13`) and as an invariant (`DECISIONS.md` ADR-004) but never specifies the contract.

**CLASS: OQ.** Not a defect in itself, but a hard dependency, because F-1.2's auto-activation policy and F-2.3's writer rule both require a decidable authorization call.

**Proposed correction (ESR).** Record the `decide()` contract as a Phase 5 prerequisite rather than leaving it implicit; Phases 5–8 each need to call it and each needs to know its failure mode. The failure mode is the part that must be fixed first: **absence of approval is denial.**

---

## 3. Investigation area 3 — Stale `CURRENT_STATE.md` information

### F-3.1 — The record's header describes a revision and a working tree that no longer exist

**Finding.** `docs/memory/CURRENT_STATE.md:3-4` reads:

> "**Record status:** Planning baseline and recovered-source update, verified 2026-11-05.
> **Repository revision inspected:** `0e7fdeeb28bbc26623765c88ba8816316c2c5fd5` (`main`; working-tree documentation changes are uncommitted)."

Both clauses are now false:

| Statement | Measured at audit time |
|---|---|
| revision inspected = `0e7fdee` | `HEAD` is **`36a3e18`** — three commits later (`0e7fdee` → `01ac126` → `36a3e18`) |
| "working-tree documentation changes are uncommitted" | working tree is `?? .gitignore` — **clean**, no documentation changes pending |
| the research file and its notes are described as just added (`:20-25`) | both are **committed** as `36a3e18`, "docs: preserve recovered Lain research provenance" |

**CLASS: verified defect.** Stale, not wrong-when-written.

### F-3.2 — "Next action" is stale three times over

**Finding.** `CURRENT_STATE.md:36` directs the next reader to *"Continue with the repository-foundation milestone in `IMPLEMENTATION_ROADMAP.md` and `INITIAL_BACKLOG.md` … Establish conventions, validate the leading toolchain candidate with a bounded proof of concept, and create a reproducible build/check baseline before beginning Core implementation."*

**CLASS: verified defect.** Three problems:

1. The vault commit already **edited this line** once (`01ac126` shows it as one of the 7 deletions). It has now been overtaken again.
2. It points at repository-foundation work, while the audit's risk analysis places the **highest-risk unknown first**: whether a small local model can reliably drive a tool-calling loop at all (`.lain-audit/17-owner-decisions.md` OD-2). Toolchain conventions are cheap to defer; the model-reliability question is not.
3. "Establish conventions … before beginning Core implementation" has no defined completion condition, so the reader cannot tell when it is done — while the same file's own "Current position" section (`:18`) correctly notes there is no completion evidence for any milestone. A next action that cannot terminate is a defect in a state record.

### F-3.3 — The record cannot detect its own staleness

**Finding.** There is no mechanism — no date, no revision link, no "verify before trusting" marker in the reader protocol — that would tell a future session this file is three commits out of date. `AGENTS.md:27` tells every session to read it; `docs/memory/README.md:7-11` calls it "verified repository state".

**CLASS: verified defect (structural).** The failure is silent by construction: a stale record reads exactly like a current one.

**Proposed correction (ESR) for F-3.1–F-3.3.** Two lines make the record self-invalidating: (a) state the **audited commit** and require the reader to compare it against `HEAD`; (b) add one sentence to the reader protocol — *"If the recorded revision is not an ancestor of, or equal to, the current `HEAD`, treat every 'verified' claim in this file as unverified until re-checked."* This is the smallest change that converts a silent failure into a loud one, and it needs no new tooling.

### F-3.4 — Measured environment facts are recorded without a volatile-fact marker

**Finding.** `CURRENT_STATE.md:25` records "the GPU at 0% utilization with 571 MiB in use, and `ollama ps` listed no loaded model". These were true when written. At audit time the GPU was **655 MiB used at 7 %** and **no Ollama daemon was listening** at all — so even the *shape* of the observation has changed.

**CLASS: HIS.** Environment facts are historical the moment they are written; recording them as part of "Recovered conversation and usage guidance" invites a later reader to treat them as current.

**Proposed correction (ESR).** Move volatile environment observations out of the state record into a dated measurement log, or mark them inline as *"measured 2026-11-05; re-measure before relying on it."*

### F-3.5 — "Verified facts" section is accurate but now incomplete

**Finding.** `CURRENT_STATE.md:6-14` is honest and still substantially true (`:9` "no implementation source tree" — re-verified: **zero** source or config files exist outside `.git` and `.lain-audit`; `:14` "acceptance tests are behavioral targets, not evidence"). But it does not mention the three local commits are **unpushed** (`main` is ahead of `origin/main` by 3), which is the single most operationally significant fact about the repository's current state.

**CLASS: verified defect (omission).** A state record that omits "this work exists only on this machine" is missing its most load-bearing item.

### F-3.6 — `.gitignore` exists, is effective, and is unrecorded

**Finding.** `.gitignore` is present, **77 lines**, sha256 `F1D6A2E3E0FD3DD3A44818E4630A2490964AE1CD779BBAEC87E1F2512FFBB830`, and it does what it is for: `git check-ignore` confirms `.lain-audit/` is excluded by its line 18. It is untracked, and `CURRENT_STATE.md` never mentions it.

**CLASS: verified defect (omission).** This is the W-1 risk from the audit (a blanket `git add -A` staging 142 MB of benchmark databases) mitigated by an **uncommitted** file. Being untracked, the mitigation does not travel: a fresh clone has no protection at all. `AGENTS.md:33` ("Never overwrite, reset, discard, or claim ownership of existing work") is not a substitute for an ignore file.

---

## 4. Investigation area 4 — Missing or incomplete `VISION.md`

### F-4.1 — `VISION.md` does not exist

**Finding.** Measured: `VISION.md` **absent**. Also absent: `LICENSE`, `RESOURCE_BUDGET.md`, `CODING_STANDARDS.md`, `CONTEXT.md`, `.editorconfig`, `Makefile`, `justfile`, `.github/`, and **every** dependency or build manifest (`package.json`, `tsconfig.json`, `Cargo.toml`, `pyproject.toml`). There is **no build command and no test command in the repository** — audit defects B-1/G-2 remain open, and acceptance test AT-001 ("repository builds") therefore still has no defined meaning.

**CLASS: verified defect.**

### F-4.2 — The consequence is already measurable: the mission is absent from the repository

**Finding.** The user's own statement of the product — from the recovered audit brief at `docs/research/sources/recovered-lain-conversation.txt:11679-11686` — names long-term capabilities including a **visual Design Studio** and a **3D Knowledge Universe**. Neither appears in any canonical document except as a passing mention. Measured word coverage in the canonical tree: the income/monetization objective and the design/knowledge-universe capabilities are represented only inside `docs/research/` and the reconciliation prose.

**CLASS: EUR** (the user said it) recorded as **UAP** (the repository treats it as unstated).

**Why this is not cosmetic.** Phases 7 and 8 of the current program — Evaluation Lab, Research Lab, and the entire Business Intelligence phase, whose stated purpose is *"Lain should eventually produce useful economic outcomes"* — descend from that mission. The mission is recorded in the repository only by accident, inside a research file whose own header says it is *"historical source material, not a replacement for the current repository"*. A future contributor reading only the canonical documents cannot learn what Lain is for.

### F-4.3 — A `VISION.md` is safe to create and must be marked as non-normative

**Proposed correction (ESR).** Create `VISION.md` with exactly four things, and no more: (1) the product statement, quoted from the user's own words; (2) the long-term capability list, each explicitly marked **not in scope for v0.1**; (3) the standing constraints that outrank convenience ($0-first, fail-closed, security outside the model, reversible decisions, verification over demonstration); (4) a one-line pointer stating that it is **not** a specification and that any capability in it requires an Accepted decision before implementation.

That last line is the important one: a vision document that is not marked non-normative becomes a back door for scope inflation, which is the failure this project has already identified and cut once.

---

## 5. Cross-document integrity review

### F-5.1 — The false join: `SYSTEM_BOUNDARIES.md:9` contradicts `ARCHITECTURE.md`

**Finding.** `SYSTEM_BOUNDARIES.md:9` assigns ownership: *"Sessions and turns → Session Manager"*. `ARCHITECTURE.md:150-157` now also has a Collaboration Service owning *"communication records, discussions, broadcasts, reviews, and disputes"* — while the transcript's review loop (`.txt:12670-12688`) treats review as part of the session/task record.

**CLASS: contradiction (UNV).** Two documents now describe the same activity under different owners, and only one of them is in the ownership table.

### F-5.2 — The lifecycle gap: nothing specifies what happens to a task whose reviewer disagrees

**Finding.** The recovered transcript proposes `review.rejected` and `decision.disputed` events (`:13405-13414`) and the reconciliation layer makes the Collaboration Service own "disputes" — but no document states the resolution rule: who decides, whether a rejected review blocks a task, whether reassignment is permitted, or what the terminal state is.

**CLASS: OQ.** Phase 5 requires an answer (`PART 4 §5.2` explicitly asks for conflict resolution and reassignment), and it cannot be derived from the repository.

### F-5.3 — Verified: the accepted-decision set is internally consistent

**Finding.** `DECISIONS.md`'s Accepted entries (ADR-001, 002, 003, 004, 005, 009, 012, 013) do not contradict each other or the architecture at any point this audit could find. The Proposed entries (006, 007, 008) and Experiment-required entries (010, 011) are correctly labelled as such. **This is a pass, recorded because a review that reports only defects invites the reader to distrust the documents wholesale.**

### F-5.4 — Verified: the recovered research is honestly labelled

**Finding.** `docs/research/RECOVERED_CONVERSATION_NOTES.md:12` states the material is *"historical source material, not a replacement for the current repository or `DECISIONS.md`"*, and `:29` states *"Historical hardware, benchmark, and security claims still require verification against original evidence."* The provenance hash it records matches the archived file byte-for-byte. **This is the standard the rest of the documentation should meet, and it is currently met only here.**

---

## 6. Security-boundary review

| # | Finding | Class | Status |
|---|---|---|---|
| S-1 | `SECURITY_MODEL.md:42` promises container/VM isolation. Measured: no Docker, no WSL distribution, and Windows Sandbox/WDAC require elevation the session token cannot obtain. | **UNV** | Open. Corrected only by rewriting the isolation section to name mechanisms that exist: low-integrity token + MIC, Job Objects, ACLs, with containers as an optional user-installed tier. |
| S-2 | Containment is **verified** for 9 of 11 escape classes, with 2 **not testable** on this machine and 2 explicitly not covered (8.3 names disabled; UNC unreachable for this token). MIC bounds only *higher*-integrity objects; low→medium UI/COM escalation is untouched. | **HIS/UNV** | Verified scope exists but is **not stated in any canonical document**. The canonical document states the *unsupported* stronger claim. This inversion is the most dangerous single item in the repository. |
| S-3 | The "does it break legitimate work" question is unanswered: whether a low-integrity child can run `node`, `git`, and `python` with their temp/cache writes succeeding. | **OQ** | Open. Until answered, no canonical document may claim MIC is *usable* — only that it contains. |
| S-4 | `SECURITY_MODEL.md` approval gates do not state timeout semantics. | **UNV** | Open. Recommendation on record: timeout → **Deny**, with `DenyIndeterminate` distinct from a user's explicit "no"; "wait forever" unsupported. |
| S-5 | Cancellation semantics unspecified. Killing a Windows parent process does not kill its children, so "cancel" is currently undefined at the OS level. | **UNV** | Open. Requires a Job Object (kill-on-close) design. |
| S-6 | Event payloads are append-only, so a secret written once is permanent; no store-level redaction-on-write is specified. | **UNV** | Open. |
| S-7 | F-1.2's auto-activation of "low-risk" extensions would install and activate **executable third-party content** on the strength of three undefined terms. | **OQ** | Open. Must be resolved before any extension loader is built. |

**Security-boundary verdict.** The repository currently **overstates** its isolation guarantee and **understates** its verified containment result. The corrected statement is both weaker and safer: *"Containment is provided by a low-integrity token with Mandatory Integrity Control, verified non-elevated on Windows 11 against 9 of 11 escape classes, with 2 untestable on this hardware; it is not a boundary against a determined local process and does not bound writes to other low-integrity locations."*

---

## 7. Documentation-quality review (falsifiability)

| # | Finding | Class | Status |
|---|---|---|---|
| Q-1 | `ACCEPTANCE_TESTS.md` has 39 tests and **zero numeric thresholds** — a regex for `\d+\s*(ms\|s\|seconds\|MB\|GB\|tokens\|bytes\|%)` matches only test IDs. The suite cannot fail. | **verified defect** | Open (A-1/D-5). Revised thresholds exist historically in `.lain-audit/14-acceptance-criteria.md`, labelled **M** measured / **D** derived / **P** proposed. |
| Q-2 | AT-065 cites "documented limits" documented nowhere; there is no `RESOURCE_BUDGET.md`. | **verified defect** | Open. |
| Q-3 | The first milestone is defined **three different ways** across `INITIAL_BACKLOG.md:38`, `IMPLEMENTATION_ROADMAP.md` (Phase 1 exit), and `ARCHITECTURE.md:146` — three different amounts of work. | **verified defect** | Open (D-1). |
| Q-4 | ADR status vs `ARCHITECTURE.md` imperative mood: a reader of one document believes the choices are settled, a reader of the other believes they are open. `AGENTS.md` ranks the ADR register above project-state documentation, so the register wins — but the contradiction remains unresolvable for anyone reading only the architecture. | **verified defect** | Open (D-2). |
| Q-5 | No target OS is named in the canonical documents, although the entire containment strategy is OS-specific. | **verified defect** | Open (G-1). |
| Q-6 | No dependency or version-pinning policy exists; "minimal dependencies" is a value, not a rule. | **verified defect** | Open (G-6). |

**Quality verdict.** The documents are coherent, well-sequenced, and honest about their own status — and simultaneously **unfalsifiable**. That combination is the specific risk: nothing in the suite can contradict a plan, so progress is asserted rather than measured.

---

## 8. Proposed corrections, ordered by consequence

Each proposal names the file, the change, and the class. **None is applied.**

| # | Target | Proposed change | Class | Blocking |
|---|---|---|---|---|
| C-1 | `SYSTEM_BOUNDARIES.md` | Add the events owner row and the single normative single-writer sentence. | ESR | **Phases 5–8** |
| C-2 | `SECURITY_MODEL.md:42` | Replace the container/VM promise with the verified containment statement and its stated ceiling. | ESR | **yes** |
| C-3 | `ARCHITECTURE.md:157` | Delete "existing"; restate mod integration as intent + dependency. | ESR | Phase 6 |
| C-4 | `VISION.md` (new) | Four sections, explicitly non-normative. | ESR | Phase 8 |
| C-5 | `docs/memory/CURRENT_STATE.md` | Re-record at `36a3e18`, add audited-commit field, add the "unpushed, ahead by 3" fact, record `.gitignore`, move volatile measurements out. | ESR | no |
| C-6 | `AGENTS.md` | Add the staleness rule from F-3.3 and "absence of approval is denial". | ESR | no |
| C-7 | `DECISIONS.md` | Demote the auto-activation clause to an unapproved proposal; record the three definitions it needs. | ESR | Phase 6 |
| C-8 | `ACCEPTANCE_TESTS.md` + new `RESOURCE_BUDGET.md` | Apply numeric thresholds, mark P-thresholds as non-gating. | ESR | no |
| C-9 | All canonical docs | One canonical milestone definition, referenced everywhere instead of restated. | ESR | no |
| C-10 | `DECISIONS.md` | Record the language decision and reconcile ADR-011's status against the architecture. | ESR | no |

**Order matters for one reason only:** C-1 and C-2 change *truth claims that are currently false*. C-3 through C-10 are either decisions or hygiene. The first group should not wait for the second.

---

## 9. Open questions this audit cannot resolve

| # | Question | Why it needs the user |
|---|---|---|
| OQ-1 | Is a mod allowed to intercept internal events (the borrowed design), or is that capability reserved to Core? | It changes the extension trust model completely: interception is a **higher**-privilege surface than the "low-risk declarative" framing assumes, and the two cannot both be true. |
| OQ-2 | Does "low-risk declarative extension" auto-activation survive, or is ADR-012's strict reading permanent? | It is a security policy decision about installing executable third-party content. |
| OQ-3 | Who owns the event log — a new Event Store, or the Session Manager? | It determines whether Phase 5 introduces a component. |
| OQ-4 | Does real toolchain work succeed inside a low-integrity workspace? | Decides whether MIC is *usable* containment or containment that breaks `node`/`git`/`python`. |
| OQ-5 | Is the target OS Windows-only for v0.1? | Every containment mechanism verified so far is Windows-specific; the architecture never says so. |
| OQ-6 | What is the terminal state of a task whose independent review is rejected? | Phase 5 requires the rule; the repository is silent. |
| OQ-7 | Is the income objective in scope for the product, and if so at which phase? | Phase 8 exists because of it, but no canonical document states it. |

---

## 10. Verification of this audit

| Check | Result |
|---|---|
| Canonical documents modified | **0** |
| Files staged | **0** |
| Commits created | **0** |
| `HEAD` before and after | `36a3e18003ad41171be96d28cfbbda5b5304441c` (unchanged) |
| Working tree before and after | `?? .gitignore` (unchanged) |
| `.lain-audit` touched | No — 144 files, read-only |
| Checkout B / backup V / backup W touched | No |
| Repository state-changing commands executed | None (no `add`, `commit`, `push`, `fetch`, `checkout`, `clean`, `rm`) |
| Findings citing file:line | 18 of 18 |

**Files created by this audit:** `docs/research/phase-4-documentation-audit/README.md`, `docs/research/phase-4-documentation-audit/00-documentation-audit.md`. No canonical document was touched.
