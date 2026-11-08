# Phase 6 — Extensibility: Architecture, Contracts, Trust and Lifecycle

**Status:** Research and proposal. **Nothing here is an accepted decision.**
**Audited base revision:** `36a3e18003ad41171be96d28cfbbda5b5304441c`
**Historical input:** `Rewrite Rust Tweet.txt` — "Stage 6: Unified Extension Contracts & Interoperability" (26 894 B, 1 061 lines, sha256 `EA58FE9834D1C9D5E0584A35685720FA4810A9BBFA777F5A7D358A608E44E570`), located **outside the repository** in a volatile Downloads path (Phase 4 F-1.3). Treated as historical research, verified where checkable, and **not** as a finalized specification.
**Classification labels:** EUR explicit user requirement · EAD existing accepted decision · ESR evidence-supported recommendation · UAP unapproved proposal · UNV unverified assumption · HIS historical · OQ open question.

---

## 0. What this phase must not repeat

Three failure modes are visible in the current repository and must not be reproduced here:

1. **Claiming infrastructure that does not exist.** `ARCHITECTURE.md:157` says mods "use the **existing** extension contracts, registry, lifecycle, execution isolation, and Policy Engine". None of these exist (Phase 4 F-1.1). Every statement below therefore names what exists and what must be built.
2. **Reasoning from a third-party product's framing.** "Mods" entered this project from a Claude Code announcement (2026-10-01) that the transcript calls *"looks genius"* and proposes to borrow (Phase 4 F-1.4). Borrowing a concept is fine; borrowing its vocabulary *and* its trust assumptions is not. §3.9 re-derives mods from first principles and reaches a different conclusion about their risk.
3. **Turning requirements into permissions.** The Stage 6 research's strongest finding — *requirements are not permissions* — is the rule this phase is built around, and the repository currently contains a live counter-example (Phase 4 F-1.2: an auto-activation clause resting on three undefined terms).

---

## 1. Taxonomy

### 1.1 The governing decision: a package contains components, and components do not share one execution model

**ESR (adopting and strengthening the Stage 6 position).** An *extension* is a **package**. A package contains **components**. The package contract says what is inside and how it is identified; the component contract says what each component does and requires; the runtime contract says how trusted infrastructure loads and operates it. **The system declares; the runtime executes; the Policy Engine authorizes.** A contract layer that attempts to do all three becomes the "giant manifest" that the Stage 6 research explicitly rejects.

**ESR — no universal executable format.** Forcing every component into one runtime forces every component to the least capable model of execution. A skill is instructions consumed by a model; a tool is code invoked by a runtime; an MCP connection is a protocol conversation with an external process; a hook is a callback; a workflow is a composition. Unifying these into one format would either over-privilege skills or cripple tools.

### 1.2 The component types (ESR)

| Type | What it fundamentally is | Execution model | Highest-risk property |
|---|---|---|---|
| **Tool** | a capability invoked by a runtime | in-process or subprocess call with a schema | it executes code |
| **Skill** | structured instructions the model reads | **no execution** — content injected into context | it consumes context and can steer the model |
| **Agent** | a configuration of the agent runtime (Phase 5) | long-lived loop under orchestration | it can request capabilities and act across steps |
| **MCP connection** | a protocol binding to an external process | separate process, protocol-mediated | it is a **network/process boundary** and its tool list is attacker-controlled |
| **Hook** | a callback at a defined lifecycle point | invoked synchronously, must be bounded | it runs inside a trusted step |
| **Workflow** | a declarative composition of other components | interpreted by Core | it inherits the union of its parts |
| **Mod** | an **event interception + transformation** contract | invoked on matching events | **it can alter what the system perceives** — see §3.9 |
| **Interface extension** | a UI/workspace contribution | client-side only | it may misrepresent system state to the user |
| **Creator-generated component** | any of the above, produced by Lain | inherits its type's model | its provenance is machine-generated, not human-reviewed |

### 1.3 The type-collapsing decisions, stated explicitly

Two reductions are proposed, each with its reason:

- **"Plugin" is not a component type — it is the package.** A "plugin" is what you install; its contents are components. Keeping "plugin" as a *type* creates the ambiguity where a package and a component appear to have the same contract.
- **"Mod" is a hook with event-transformation scope and a higher trust tier, not a peer of tool/skill.** The repository currently calls mods "a distinct extension component" (`ARCHITECTURE.md:156`). They are distinct in *scope and trust*, not in *mechanism*: a mod that intercepts events is a hook whose callback receives and may transform events. Modelling them as one mechanism with a scope parameter makes the trust decision explicit instead of implicit — and that trust decision is the one the current documents get wrong (§3.9).

### 1.4 What a component may never do (ESR)

1. Widen its own capabilities by declaring them (requirements ≠ permissions).
2. Select a more privileged runtime by declaring one.
3. Modify policy enforcement, audit records, secret material, or spending limits.
4. Intercept or alter a **security decision** (a policy verdict, an approval, an audit write) — regardless of declared scope.
5. Approve itself, install itself, or activate itself.

Each of these is a structural rule enforceable at load time by comparing declared fields against trusted configuration, not a runtime check the component participates in.

---

## 2. The three contract layers

### 2.1 Package contract

```
package_id          stable id in its namespace
name, description   display only; never identity
version             package version (semver-like, but see §4.3)
publisher           publishing principal id
license             required field (the Core itself has no LICENSE — Phase 4 C-4/G-7)
repository, homepage    provenance links, optional
components[]        component ids + type + relative path
dependencies[]      package-level, with version constraints  (never auto-dereferenced)
compatibility       required host API ranges, target OS, architecture
integrity           per-file hashes + package digest
provenance          origin, creation method (human | generated), signing status
distribution        local-path | catalog-reference
```

**ESR — the package manifest grants nothing.** Its `components[]` list is an inventory, not an activation list. The Stage 6 research states this and it is the single most important sentence in the layer: *"The package manifest describes what is included. It does not grant permission to execute every component."*

### 2.2 Component contract (common fields)

```
component_id        stable, independent of package location
component_type      tool | skill | agent | mcp | hook | workflow | mod | interface
name, version, description
interface_version   the contract version this component implements
input_schema        JSON Schema 2020-12 subset (validated locally)
output_schema       JSON Schema 2020-12 subset
requested_capabilities[]   a REQUEST list, never a grant
dependencies[]      component-level
runtime_requirements       what it needs to run (interpreted by trusted infra)
resource_requirements      CPU/RAM/disk/GPU expectations, if any
compatibility       host ranges
lifecycle_config    install/activate/deactivate/uninstall behaviour
provenance          author, creation method, validation record id
```

**ESR — schema handling rule.** JSON Schema is used for contracts, but **external `$ref` dereferencing is forbidden** (the MCP specification itself warns implementations against automatically dereferencing external references — a remote schema reference is a network fetch triggered by parsing a manifest). Schemas must be self-contained, or reference only bundled local files whose hashes are in the integrity set.

### 2.3 Runtime contract

```
runtime_type        tool_process | in_process_hook | mcp_client | agent_loop | workflow_interpreter | ui_client
runtime_version
entry_point         the exact executable/module/function invoked
host_interface      which host API surface it may call
resource_limits     cpu_seconds, memory, disk_write, wall_time
timeout
cancellation        how it must respond to cancellation
isolation           required containment tier (§5.4)
health              liveness expectation
error_handling      declared error taxonomy
lifecycle_callbacks which hooks it participates in
```

**ESR — the runtime contract is interpreted only by trusted infrastructure.** An extension may *request* a runtime; it may not *select* one. If a component's requested runtime exceeds its granted tier, the component does not load — silently loading it in the lower tier would mean the manifest and reality disagree, which is worse than refusing.

---

## 3. Per-type contracts

### 3.1 Tool
Required: `input_schema`, `output_schema` (both validated), `runtime_type=tool_process`, entry point, timeout, **effect class** (`none | local_reversible | local_irreversible | external`, per Phase 5 §2.5), idempotency support (can it accept an operation key?), resource limits, and the containment tier it runs in. A tool with effect class `external` is refused activation in v0.1 (EUR: no unattended external operations; the network posture is OQ-6.2).

### 3.2 Skill
Required: activation metadata (when is this skill *relevant*?), the instructional resource path, an explicit **token cost estimate**, and the capabilities the skill's instructions will *need* (declared for planning, not granted). **ESR — a skill executes nothing**, so its risk is not code execution; it is (a) context consumption and (b) model steering. A skill therefore must never be able to escalate a capability, and its token cost is part of admission control, exactly as model context is budgeted in Phase 5 §3.5.

### 3.3 Agent
Required: profile/config (prompt, tool set requested, model binding policy), capability request, budget defaults, and stop conditions. **ESR — an agent component is a preset, not a new agent type** (Phase 5 §1.1): it must map onto one of the four runtime types, and the mapping is stated in the manifest. An extension cannot introduce a fifth agent type by declaring one.

### 3.4 MCP connection
Required: transport (local process preferred; remote requires the network capability), the server's declared tool list **treated as untrusted until re-validated locally**, a name-collision policy, and per-tool effect classes. **ESR — the MCP server's own tool list is threat input, not configuration.** Its tools are remote-supplied capability descriptions; every one is re-validated against the local schema subset and mapped to a local effect class before it can be invoked. Tool-name shadowing (an MCP tool claiming the name of a built-in) is refused, not resolved by precedence.

### 3.5 Hook
Required: the lifecycle point(s) it attaches to, whether it may **block** or only observe, a hard timeout, and error semantics (a hook failure must not silently skip a security-relevant step). **ESR — minimal hook surface in v0.1:** hooks are observation-only plus a small allowlist of pre-execution checks. A blocking hook on an authorization path is a policy-bypass primitive by construction and must not exist (see also §3.9).

### 3.6 Workflow
Required: the composition graph (components + data flow), per-step budgets, and failure policy per step. **ESR — a workflow's effective capability set is the union of its components' granted sets, computed at admission.** There is no workflow-level grant that exceeds its parts.

### 3.7 Interface extension
Required: the surfaces it contributes to, the data it may read from Core (never more than the user can already see), and a strict rule that **the UI may not present a projection as canonical truth**. A client-owned layout preference is fine; a client-owned claim about task or policy state is not (this is the `SYSTEM_BOUNDARIES.md` ownership rule applied to the UI).

### 3.8 Creator-generated component
Same contract as its type, plus mandatory fields: `creation_method=generated`, the generating session/task id, the full validation record, and an explicit `reviewed_by_human: true|false`. **ESR — a generated component is never authorized by virtue of existing.** In v0.1 it is not even auto-activated when its permissions are "already authorized", because at audit time no permission-grant record exists to compare against (Phase 4 F-1.2).

### 3.9 Mods — re-derived from first principles, and the honest verdict

**What a mod is (ESR).** An event interception and transformation contract: on matching events, a mod observes the event and may transform it or the flow around it. This is a **hook with a scope parameter**.

**The risk that the current documents get wrong (ESR, correcting F-1.4).** The repository's framing places mods among "low-risk, validated declarative extensions" eligible for automatic activation. That framing was inherited from a product whose mods *intercept internal events*. Interception is the **highest** trust surface in an event-sourced system:

- An event log is this system's only account of what happened (Phase 5 §4.4). A component that can transform an event can alter the record of reality.
- An interception point that sits upstream of an authorization decision is a policy-bypass primitive.
- A component that can rewrite what the system perceives can defeat **every downstream control** without ever exceeding its declared capability set — because it changes the inputs those controls evaluate.

**Therefore (ESR, UAP):**

1. Mods are a **separate trust tier** (`tier: interception`), the highest in §5.1 — not low-risk.
2. Mods may attach only to **non-canonical** event streams: derived projections, UI state, workspace/prompt shaping. **A mod may never modify a canonical event, block an audit write, or sit on an authorization path.** This is the "cannot modify policy enforcement, audit integrity, secrets, or spending limits" sentence from `ARCHITECTURE.md:156` made structural (the current text asserts it; the contract must enforce it).
3. A mod's transformations must be **recorded as derived data with the source event id and the transformation id**, so the canonical event remains recoverable and the projection is attributable.
4. **Recommended default: mods are disabled in v0.1** — not because interception is uninteresting, but because an interception framework needs a canonical event log with a single owner (Phase 4 C-1) before it can be safely bounded, and that does not exist yet. Deferring is the same choice the roadmap already makes for swarms and GraphRAG.

**OQ-6.1 (needs the user):** given (2) and (4), does "interception at all" remain in v0.1's scope for mods, or are mods narrowed to *workspace/prompt contributions* only (which are not interception, and are then genuinely low-risk)?

---

## 4. Identity, versioning, compatibility

### 4.1 Identity (ESR, adopting the Stage 6 proposal)

`lain:<publisher>/<package>/<component>` — with **separate identifiers for separate purposes**, because reusing one identifier for two purposes is the defect that makes revocations ambiguous:

| Id | Identifies | Must survive |
|---|---|---|
| publisher_id | the publishing principal | renaming of packages |
| package_id | an installable package | version updates |
| component_id | a component | moving within a package |
| runtime_id | an execution environment | restarts |
| instance_id | a loaded instance | — (per-run) |
| execution_id | one operation | — (per-call, and it is the idempotency key's basis) |
| **approval_id** | **one permission decision** | the grant it authorized |

**ESR — the missing identifier is the important one.** The repository has no notion of an *approval/ grant identity*: "permissions already authorized by the user" (DECISIONS.md reconciliation) names a thing that does not exist. Any auto-activation argument that depends on "already authorized" is unimplementable until grants are first-class records with ids that can be cited, expired, and revoked.

**ESR — identity movement rule.** A component keeps its identity across compatible versions and updates; if it moves to a different package or publisher, it acquires a **new** identity and the old one is recorded as superseded (never silently re-pointed). Re-pointing an approved identity at new code is how a trusted name starts running untrusted code.

### 4.2 The requirement/permission split, mechanically

```
requested_capabilities   (from the manifest)  ──┐
                                                ├──► effective_capabilities = requested ∩ granted_by_policy
granted_capabilities     (from grant records) ──┘        (never a union, never additive)
```

- A grant is a **record**: `{grant_id, subject (component or package id + version + digest), capabilities[], scope, issued_by, issued_at, expires_at, revoked_at, reason}`.
- A grant is bound to a **content digest**, so updating a component invalidates its grant until re-approved. This is the mechanism that prevents "approved once, then silently modified".
- **ESR — denial is the default and the absence of a grant is a denial** (ADR-005's pattern applied to extensions).

### 4.3 Compatibility (ESR)

- Every component declares the host API ranges it needs, and the host declares what it provides. Compatibility is a **check**, never an assumption based on a version number's shape.
- **Schema compatibility is checked structurally**, not by semver faith: a host-side diff of the declared input/output schema against the previous version classifies the change as additive (tolerable), narrowing (requires re-approval), or breaking (refuse to load). A schema change that narrows accepted inputs is a behavioural change and must not be treated as a patch.
- **Refuse rather than degrade**: an incompatible component does not load. Loading with warnings produces a system whose behaviour does not match its manifests, which is precisely the state Phase 4 found in the canonical documents.

---

## 5. Installation, trust and permissions

### 5.1 Trust tiers (ESR, UAP)

| Tier | Source | Default posture | Grant requirement |
|---|---|---|---|
| `core` | shipped with Lain | active | none (but still capability-declared and audited) |
| `local_user` | authored by the owner on this machine | installable, activatable | grants issued by the user; no signing required |
| `generated` | produced by Creator Mode | installable **after full validation**; **not activated automatically** | explicit per-component approval in v0.1 |
| `third_party` | external, unverified | **quarantined by default**: stored, never on the load path, no tools registered | explicit trust decision + grants; signature if available |
| `interception` | any component requesting event transformation (§3.9) | **disabled in v0.1** | not grantable in v0.1 |

**ESR — quarantine is a real state, not a warning.** A quarantined package is inert: not loaded, not discoverable as a capability, not on the execution path. "Installed with a scary label" is not quarantine.

### 5.2 What a signature buys on a single-user machine (ESR — an honest limit)

Third-party signing is only meaningful if something is willing to make a trust decision based on the signature. On this machine the publisher and the consumer are the same person, so a signature's real value is **integrity over time** (detecting that a package changed after approval), not **provenance trust** (there is no third party whose attestation changes the decision). The design implication: **content digests pinned at approval time are the load-bearing mechanism; signatures are optional metadata until a real second publisher exists.** Stating this avoids building a PKI to solve a problem this system does not yet have.

### 5.3 Capability grant flow (ESR)

```
component requests capabilities (manifest)
        │
        ├─ hard filter: any capability outside the built-in allowlist? → quarantine, record reason
        │
        ├─ risk classification: does any requested capability touch
        │     network | process spawn | filesystem outside workspace | secrets |
        │     policy/audit | spending | persistent scheduling?
        │
        ├─ none of the above → grant may be issued by policy; recorded with grant_id
        │
        └─ any of the above → explicit human approval required, per capability,
                              bound to the content digest, with expiry
```

**ESR — no manifest grants itself permissions** (EUR: the model never authorizes itself; ADR-004). The flow above runs in the Core, and no component participates in it.

### 5.4 Containment and resource limits (ESR, stating the ceiling honestly)

Extension execution inherits the verified containment story, and the documents must not overstate it:

| Tier | Mechanism | Verified status |
|---|---|---|
| Workspace containment | low-integrity token + MIC + ACLs | 9/11 escape classes contained; 2 untestable; **bounds higher-integrity objects only** — not a boundary against a determined local process |
| Process control | Job Object (kill-on-close) | Required; cancellation correctness is S-5 and is currently unverified for the toolchain |
| Resource limits | per-component budgets, enforced by the host | To be built; limits are only real if a positive control proves them |
| Network | denied by default | Posture decision is OQ-6.2 |
| Secrets | handles, not values | Design rule; no implementation exists |

**ESR — the honest sentence that must appear wherever extension sandboxing is described:** *containment limits what an extension can reach by accident or by ordinary malice; it is not a security boundary against code that is actively hostile and run by a user who can also run code outside it.*

### 5.5 Uninstall, revocation, rollback

- **Uninstall** removes the load path, releases grants, and retains the record (an audit trail that forgets uninstalls cannot explain a later failure).
- **Revocation** is a first-class operation: revoke a grant (component keeps running only if it needs nothing revoked — otherwise deactivate), revoke a package (deactivate all its components), revoke a publisher (quarantine all).
- **Rollback** requires the previous version to still exist locally and its grant to still be valid; otherwise rollback is an install, with the full approval flow. **ESR — rollback is not a bypass of approval.**

---

## 6. Lifecycle states

```
discovered → validated → installed → granted → activated → deactivated → uninstalled
     │            │            │          │          │            │
     └────────────┴────────────┴──────────┴──────────┴────────────┴──→ quarantined
                                                                      revoked
```

**ESR — every transition writes an event, and each state has a defined meaning:**

| State | Means | Does not mean |
|---|---|---|
| validated | passed schema, integrity, compatibility and static checks | trusted |
| installed | present in the local store, digest recorded | on the load path |
| granted | specific capabilities authorized by a named grant | active |
| activated | components loaded and available | allowed to do anything beyond granted capabilities |
| deactivated | not loaded; grants may persist | uninstalled |
| quarantined | present but inert; no load path, no tool registration | deleted |
| revoked | grants withdrawn; components cannot activate | removed from history |

**ESR — creation, installation, authorization and activation are four different things** (EAD, ADR-012). The lifecycle above is the mechanical form of that decision: there is no single call that performs two of them, and no state transition that implies a grant.

---

## 7. Discovery

**ESR — a marketplace is not required and not planned for v0.1** (EUR: $0, minimal dependencies). Discovery is:

1. **Local registry** — a table in the Core store, keyed by component id, recording state, digests and grants. This is the only registry that exists at runtime.
2. **External catalogs** — optional, *read-only* sources of metadata, never auto-installing, never auto-updating, and never a runtime dependency for any capability.
3. **Installation preview** — before any install, show: components and their types, requested capabilities with a risk classification, required host API ranges, resource limits, dependencies and their provenance, and what activation would change. **ESR — the preview is a contract, not a marketing page:** approving the preview approves a specific set of digests and capabilities, and any deviation invalidates the approval.
4. **Updates** — never silent. An update that changes capabilities, narrows schemas, or changes the digest re-enters the approval flow. An update that changes none of those may apply automatically *if* the user opted in per package.
5. **Deprecation** — a component may declare itself deprecated with a reason and a successor id; the registry surfaces it and refuses new grants.
