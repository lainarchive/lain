# Security Model

**Version:** 0.1 | **Status:** Initial threat model. Refine before enabling real execution or unattended operation.

## 1. Objective
Allow useful reasoning and action without letting a model, plugin, tool output, compromised provider, or malformed request grant itself authority or cross user-defined boundaries. Trusted code and OS controls enforce security, not prompt wording.

## 2. Assets
User files and source; credentials and provider keys; sessions and memory; client data; budgets/prepaid balances; local processes/resources; plugin environments; repository history/artifacts; approvals and audit records.

## 3. Threat sources
Malicious/compromised plugins; prompt injection in pages, documents, repositories, and tool output; misleading model output; provider compromise/misconfiguration; malformed tool inputs; accidental configuration; supply-chain compromise; runaway loops/retries/resource use; unauthorized clients/processes.

## 4. Trust boundaries
1. Client to Core: authenticate and validate every request.
2. Agent to capability: treat requests as proposals; authorize each invocation.
3. Core to executor: enforce filesystem, network, process, time, and resource limits outside the model.
4. Plugin to host: isolate execution and expose only approved capabilities.
5. External content to knowledge: preserve source and untrusted labels.
6. Core to provider: minimize transmitted data; enforce provider/privacy rules.
7. Secrets to runtime: narrow secret access; redact outputs.
8. Budget to router: enforce hard limits independently of model instructions.

## 5. Authorization
A decision considers principal, action, capability, resource/path scope, environment, data classification, network destination, time/resource limits, budget/provider policy, and approval state. Use least privilege. Delegated agents cannot exceed parent task authority. Re-check at execution time.

Permission categories (not an automatic cumulative ladder): observe; workspace read/write; execute in approved workspace; integrate with approved services; bounded autonomous operation; unattended operation. Higher categories remain disabled until separately designed and authorized.

## 6. Approval gates
Require explicit approval for destructive data changes, external publishing/sending, executable plugin activation, sensitive account/data access, security-policy changes, purchases/charges, protected-branch integration/deployment, and binding legal/financial/contractual commitments. Approval identifies action, target, scope, impact, and expiry. One approval does not authorize adjacent actions.

## 7. Cost/provider controls
Unknown pricing is not free. Unknown quota/tier fails closed under free-only policy. Fallbacks cannot weaken provider, privacy, capability, or budget restrictions. Enforce request/task/agent/project/provider/global limits. Distinguish estimates from provider-confirmed usage. Stop or request approval when balance/pricing cannot be verified. Models cannot edit budgets.

## 8. Prompt injection
External pages, emails, files, code comments, issues, model output, and plugin metadata are untrusted data. Embedded instructions never override policy or user authorization. Preserve provenance; do not promote external instructions into trusted memory. Validate tool outputs against schemas.

## 9. Secrets and privacy
Never store credentials as ordinary memory. Exclude secrets from logs, event payloads, crash reports, and generated docs. Use scoped references and redaction. Minimize external transmission, isolate project/client scopes, and define retention/deletion behavior.

## 10. Execution isolation
Use restricted workspaces and process boundaries. Apply filesystem allowlists, network controls, process restrictions, deadlines, CPU/RAM/output limits, and cancellation. Prefer app APIs/accessibility interfaces over visual automation. Sensitive UI actions require confirmation.

**Verified containment ceiling (corrected 2026-11-08).** The previous text required verifying "actual container/VM isolation on target OS". No container or VM
substrate exists on the target machine (no Docker, no WSL distribution, and Windows Sandbox or WDAC require elevation), so that requirement could not be met and
was not a control. What has been measured is narrower and is stated here instead: a low-integrity process spawned through a restricted token is contained against
nine of eleven tested escape classes — symbolic link, junction, hard link, case variant, alternate data stream, `\\?\`, `\\.\`, trailing dot and trailing space —
with the remaining two classes **not testable** on this volume and therefore not claimed. Two limits are known and unmitigated: low-integrity enforcement bounds
only objects of higher integrity, so a low-integrity process can still write other low-integrity locations, and low-to-medium UI/COM escalation is not addressed.
Containers remain an optional, user-installed, non-default tier. No document may describe this system as containerised, sandboxed, or VM-isolated until a
substrate that provides it is present and exercised.

## 11. Plugin/dependency security
Inspect manifest, permissions, source, dependencies, and install scripts. Validate schemas and provenance. Test in isolation. Grant only approved capabilities. Pin/record versions. Support disable, revoke, and removal. Generated plugins remain untrusted until reviewed.

## 12. Audit and incident response
Record authorization, approvals, tool invocations, routing, execution start/stop, budget thresholds, plugin lifecycle, and security config changes without secret values. Provide stop/cancel, credential revocation, plugin disable, execution termination, evidence preservation, restore, and root-cause review.

## 13. Security gates
Before broad execution, test that unauthorized calls are denied; path/network restrictions cannot be bypassed; prompt injection grants no capability; unknown pricing cannot enter free-only routing; no unauthorized paid fallback occurs; secrets stay out of memory/logs; plugin failures are contained; cancellation/resource limits work; agents cannot weaken policy.

## Reconciliation: collaboration and mod security

Agent messages, review results, broadcasts, and claimed approvals are untrusted proposals. They cannot grant permissions, alter protected decisions, or bypass Policy Engine checks. Mods are untrusted extensions: validate manifests, dependencies, compatibility, requested capabilities, and lifecycle transitions; isolate executable behavior; and reauthorize protected operations. Mods cannot modify policy enforcement, audit history, secrets, or spending limits. A blocked task may checkpoint and pause; unrelated work may continue only within already-authorized scope. Resumption requires policy and precondition checks. This does not relax restrictions on unattended external operations or autonomous financial commitments.
