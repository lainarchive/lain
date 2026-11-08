# Phase 6 — Extensibility: Creator Mode, Security Model, Acceptance Tests, Backlog

**Status:** Research and proposal. **Nothing here is an accepted decision.**
**Base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Companion:** `00-extension-architecture-and-contracts.md` (taxonomy, contracts, identity, trust tiers, lifecycle).
**Labels:** EUR explicit user requirement · EAD existing accepted decision · ESR evidence-supported recommendation · UAP unapproved proposal · OQ open question.

---

## 1. Creator Mode

### 1.1 What it is, precisely

**EUR.** The user describes a capability in natural language and Lain builds it: research → design → implement → test → document → package → present for approval. The user's own words in the recovered transcript (`:540-560`) add: *"eventually, I want the CLI itself to be customizable through this system. Same goes for the desktop application."*

**EUR — the invariant that governs everything below:** *"Creation must never automatically imply authorization or activation."* That is ADR-012 (Accepted), and it is the one rule Creator Mode may not trade away for convenience.

### 1.2 The creation pipeline (ESR — fifteen stages, four gates)

| # | Stage | Output | Gate |
|---|---|---|---|
| 1 | **Intent capture** | a task contract (Phase 5 §2.1): objective, acceptance criteria, target component type, scope, budgets | **G-1: admission.** No acceptance criteria → not admitted. |
| 2 | **Requirement clarification** | the smallest set of questions whose answers change the design; each with a default | — |
| 3 | **Prior art search** | existing components, libraries, MCP servers; **and an explicit statement of what was searched** | — |
| 4 | **Design** | package/component/runtime contracts drafted; capability list with risk classification; alternatives considered | **G-2: design review.** A human-readable design is presented *before* code generation for anything requesting a sensitive capability. |
| 5 | **Implementation** | component source + manifest in a scratch workspace | — |
| 6 | **Test generation** | tests derived from the acceptance criteria, not from the implementation | — |
| 7 | **Static and security checks** | schema validation, dependency inspection, secret scan, forbidden-pattern scan | — |
| 8 | **Isolated execution** | the component runs in the contained workspace under its *requested* (not granted) limits | — |
| 9 | **Behaviour evaluation** | observed behaviour vs declared behaviour: does it do only what it declared? | **G-3: validation.** A component that exceeds its declared capability set is rejected outright, not re-scoped. |
| 10 | **Documentation** | what it does, what it needs, how to remove it, known limits | — |
| 11 | **Packaging** | digests computed, provenance recorded (`creation_method=generated`, session/task id, validation record id) | — |
| 12 | **Inspection presentation** | the installation preview (Phase 6 §7.3) plus the validation record and the honest limits | **G-4: approval.** Per-component, per-capability, bound to digests. |
| 13 | **Installation** | on the load path only after G-4 | — |
| 14 | **Activation** | separate explicit action; never bundled with installation | — |
| 15 | **Monitoring** | runtime behaviour recorded against declared behaviour; deviation is an event | — |

**ESR — four gates, and why each exists.** G-1 prevents unmeasurable work (Phase 5's acceptance-criteria invariant). G-2 prevents expensive code generation against a wrong design. G-3 is the only stage that can detect *"it works but it does something else"*. G-4 is the authorization the user actually cares about. Collapsing any two of them produces the failure mode where a demo becomes a decision.

### 1.3 Stage 8 is the uncomfortable one (ESR — stated plainly)

Testing a generated component means **running generated code**. In v0.1, that run happens in the contained workspace, whose containment is *verified for 9 of 11 escape classes and is not a boundary against a determined local process* (Phase 6 §5.4). Therefore:

- Generated code is executed **only** with the user's explicit consent, at the moment of validation, as its own approval — not as a side effect of "create".
- Generated code runs with **no network** and **grants limited to the workspace**, regardless of what it requests, because at stage 8 nothing has been granted yet.
- The validation run's effects are confined to a scratch workspace that is **discarded**, and the discard is verified (artifact inventory = empty) rather than assumed.
- **ESR — what Creator Mode cannot promise in v0.1:** that a generated component is safe. It can promise that the component was validated, that its declared and observed behaviour were compared, and that activation required a separate human decision. That is a checkable claim; "safe" is not, and must not be written.

### 1.4 Failure handling in the pipeline (ESR)

| Failure | Response |
|---|---|
| Generation fails or produces non-compiling output | retry once with the failure attached; then return `needs_decomposition` or fail the task with the partial artifact retained — **never** present a non-building artifact for approval |
| Invalid manifest (schema violation) | reject at stage 7; the pipeline does not continue on a component whose contract cannot be read |
| Malicious or unverifiable dependency | reject the dependency; if the design cannot proceed without it, escalate to the user with the evidence |
| Permission escalation attempted (declared behaviour ≠ observed behaviour) | **reject the component**; record the attempt; do not "fix" the manifest to match observed behaviour |
| Incompatible host versions | refuse; do not emit a component that cannot load |
| Broken update (new version fails validation) | the previous version stays installed and active; failure recorded |
| Extension conflicts (two components claim the same tool id, mod scope, or event subscription) | refused at install: identity collisions are never resolved by precedence |
| Untrusted publisher / generated provenance | quarantined tier per Phase 6 §5.1 |
| Rollback requested after a bad activation | deactivate → restore the previous verified digest → re-check its grant (Phase 6 §5.5) |

---

## 2. Extension security model (consolidated)

Ten rules, each enforceable by comparing declared data against trusted configuration (ESR):

1. **Requirements are not permissions.** Requested ⊆ granted, computed in the Core, never in the component.
2. **No self-authorization.** No component participates in the decision that authorizes it.
3. **Grants bind to content digests.** A modified component loses its grant.
4. **Deny by default; absence of a grant is denial.**
5. **Quarantine is inert.** Not loaded, not registered, not discoverable as a capability.
6. **Mods may not touch canonical events, audit writes, or authorization paths** (§Phase 6 §3.9).
7. **MCP tool lists are untrusted input**, re-validated locally; no name shadowing.
8. **Skills cost context and can steer the model** — they execute nothing, so they are budgeted, not sandboxed.
9. **Every lifecycle transition, grant, denial, revocation and validation is an event.** A denial without a recorded reason is a bug.
10. **Containment claims are stated at their verified strength** (9/11 classes; not a boundary against determined hostile local code).

**Prompt-injection posture (ESR).** A component's description, documentation, tool descriptions, and MCP annotations are all **content the model may read** and are therefore untrusted input with respect to capability: none of them can grant, widen, or approve anything. This is the same rule Phase 5 §7.4 applies between agents, applied to extensions, and it must be enforced at the boundary where such content enters context — not by asking the model to be careful.

---

## 3. Acceptance-test plan (M/D/P tiers; positive control mandatory per denial class)

| ID | Test | Threshold | Tier |
|---|---|---|---|
| AT-6.01 | Requested capabilities cannot be self-granted | 0 components activate with a capability absent from their grants, across all fixtures | D |
| AT-6.02 | Grant bound to digest | after any byte change, the component does not activate without a new grant | D |
| AT-6.03 | Deny by default | 0 activations without an explicit grant record | D |
| AT-6.04 | Quarantine is inert | quarantined package: 0 registry entries, 0 loaded modules, 0 invocable tools | D |
| AT-6.05 | Runtime tier is chosen by the host | a component requesting a higher tier fails to load; 0 silent downgrades | D |
| AT-6.06 | Schema validation before execution | 0 tool invocations with an input failing the declared schema | D |
| AT-6.07 | External `$ref` forbidden | 0 network fetches triggered by manifest/schema parsing, measured by traffic capture | D |
| AT-6.08 | Mod scope enforced | mods attach to 0 canonical event streams; 0 canonical events modified | D |
| AT-6.09 | MCP shadowing refused | 0 MCP tools registered under a built-in tool's name | D |
| AT-6.10 | Lifecycle events complete | every state transition in a scripted install/activate/deactivate/uninstall sequence has exactly one event | D |
| AT-6.11 | Rollback does not bypass approval | a rollback to a version without a valid grant enters the approval flow | D |
| AT-6.12 | Creator Mode gates hold | 0 components installed without G-4; 0 activated in the same operation as installation | D |
| AT-6.13 | Generated code runs unprivileged at validation | 0 network access, 0 writes outside the scratch workspace, scratch discarded with 0 residue | M |
| AT-6.14 | Installation preview is a contract | any digest/capability deviation between preview and install is refused | P |
| AT-6.15 | Resource limits are real | a component exceeding its CPU/memory/disk budget is stopped; paired positive control within budget completes | P |

**Non-vacuity (ESR).** Each of AT-6.03, 6.04, 6.05, 6.08, 6.09 needs a paired positive control in the same run — e.g. a *granted* component must activate, a *non-matching* mod subscription must fire normally — otherwise a broken loader reports perfect security, which is exactly the E5 lesson.

---

## 4. Prioritized implementation backlog

| # | Item | Depends on | Why here |
|---|---|---|---|
| 1 | **Component identity + registry table** (ids, digests, states) | event log owner (Phase 4 C-1) | Every other item references component identity. |
| 2 | **Grant records with `grant_id`, digest binding, expiry, revocation** | 1 | Without grants, every auto-activation argument is unimplementable (F-1.2). |
| 3 | **Manifest schema validation (self-contained schemas, no external `$ref`)** | 1 | Cheapest way to make manifests trustworthy. |
| 4 | **Package/component/runtime contract loaders + refuse-on-mismatch** | 3 | The contract layer stops being prose. |
| 5 | **Lifecycle state machine with one event per transition** | 1, 2 | Auditability before capability. |
| 6 | **Local registry discovery + installation preview as a contract** | 1, 2 | The user-facing safety mechanism. |
| 7 | **Quarantine semantics (inert by construction)** | 1, 5 | Prevents "installed to try it" from becoming trusted. |
| 8 | **Tool component runtime + effect classes + idempotency keys** | 4 | First component type that executes; smallest useful extension. |
| 9 | **Skill component (token cost + relevance metadata)** | 4 | Second type; cheap, no execution risk. |
| 10 | **Creator Mode pipeline stages 1–7 (no execution yet)** | 2, 3, 6 | Produces manifests and code without running anything. |
| 11 | **Stage 8–9 validation harness (contained, networkless, discarded)** | 8, 10 | The riskiest stage; must come after quarantine and grants exist. |
| 12 | **Stages 10–15 (package, present, install, activate, monitor)** | 10, 11 | Completes the pipeline only once its gates are real. |
| 13 | **Agent component presets mapped onto the four runtime types** | Phase 5 items 4, 8 | Requires the agent runtime to exist. |
| 14 | **MCP connection with local re-validation, no shadowing** | 8 | Network/process boundary; after local types are solid. |
| 15 | **Hooks (observation-only allowlist)** | 5, 8 | Deliberately minimal surface. |
| 16 | **Workflows (union-of-grants admission)** | 8, 9, 13 | Composition multiplies the surface. |
| 17 | **Interface extensions** | CLI exists (Phase 9+) | Nothing to extend yet. |
| 18 | **Mods** | canonical event log with a single owner + a derived-projection mechanism | **Deferred by recommendation** (§3.9). |

**Sequencing rationale (ESR).** Items 1–3 are the identity/permission core, and they are the only items in this list that are *also* required by Phases 5, 7 and 8. Items 4–7 make trust decisions real. Items 8–9 prove the component model with the two simplest types. Items 10–12 build Creator Mode **in the order that keeps code generation away from execution until containment and grants exist**. Items 13–18 add surface area in ascending risk.

---

## 5. Dependencies and readiness

| Required foundational capability | Exists? | Evidence | Blocks |
|---|---|---|---|
| Canonical event log with one owner + single-writer rule | **No** | `SYSTEM_BOUNDARIES.md:8-20` (11 rows, no events) — Phase 4 F-2.3 | Items 1–18 |
| Policy Engine `decide()` contract | **No** | Owner named at `:13`; contract nowhere | Grants, activation, Creator Mode gates |
| Capability Registry implementation | **No** | Owner row `:14` only | Registry, discovery |
| Execution Runtime / containment | **No** | Owner row `:15`; containment verified as a mechanism experiment only; the "legitimate toolchain work in a low-integrity workspace" question is open (OQ-4) | Tool runtime, validation harness |
| Secret handling (handles, not values) | **No** | Design rule only | Any component needing credentials |
| Interface to extend (CLI) | **No** | No implementation exists at all | Interface extensions only |

**Verdict (ESR).** Phase 6 **cannot be implemented today** beyond items 1–3 in isolation, and item 2 (grants) cannot be *usefully* implemented before the Policy Engine contract exists, because a grant is a policy decision with an owner. What is genuinely buildable now and useful independently: **the identity scheme, the manifest/component schema definitions, and the registry table with lifecycle states** — all pure data definitions, all testable by validation, and all required by the other phases.

**Blocking correction (ESR).** `ARCHITECTURE.md:157`'s claim that mods use the *existing* contracts, registry, lifecycle, isolation and Policy Engine must be reworded (Phase 4 C-3) before any of this work is cited as though the infrastructure were present. A design document that references non-existent infrastructure is the mechanism by which the next reader over-estimates readiness.

---

## 6. Open questions

| # | Question | Why it needs the user |
|---|---|---|
| OQ-6.1 | Are mods limited to workspace/prompt contributions in v0.1, or is event interception in scope? | Interception is the highest trust tier and the current documents mislabel it as low-risk. |
| OQ-6.2 | Default network posture for extensions: deny-by-default (proposed), or per-component opt-in at grant time? | A security default with real usability consequences. |
| OQ-6.3 | Does the `## Reconciliation: low-risk extension activation` clause (unapproved) get withdrawn, or rewritten to depend on grants that do not yet exist? | ADR-012 is Accepted; this clause currently contradicts its spirit. |
| OQ-6.4 | Is third-party extension distribution in scope at all before a second publisher exists? | Signing solves a problem this system does not yet have (§5.2). |
| OQ-6.5 | Should generated components be permitted to request `local_irreversible` effects on this machine at all? | Ties to Phase 5 OQ-5.2. |
