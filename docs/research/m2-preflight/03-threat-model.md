# 03 — Threat Model

**Status:** PROPOSED threat model for the first bounded agent. Nothing here is an accepted decision.
**Date:** 2026-11-08
**Scope:** what Lain protects, from whom, at which boundaries, and — just as importantly — what it explicitly does not protect against. Scoped to M-2 (one bounded agent on this machine), not to a future multi-tenant or networked deployment.
**Verification classification:** VERIFIED (measured) · HISTORICAL · DOCUMENTED · PROPOSED · UNRESOLVED · NOT-TESTABLE.

---

## 1. The one asymmetry this model is built on

**ESR.** In a conventional system the operator is trusted and the input is not. Here, the *proposer* of actions is untrusted and the *operator* is trusted: model output — including tool calls, code, file paths and arguments — is **untrusted input**, and a tool process is an **untrusted executor**. Neither may hold authority. Authority is held by the Policy Engine and enforced by operating-system objects the controller owns.

The practical consequence, and the reason this is written down before any code: **no security decision may be expressed as an instruction to the model.** "Do not write outside the workspace" is a comment, not a control. The control is a token that cannot write there.

## 2. Assets, ranked by what their loss costs

| # | Asset | Why it matters | Consequence of compromise |
|---|---|---|---|
| A-1 | The user's Documents, source trees and personal files | Irreplaceable or expensive to reconstruct | Data loss, no recovery path |
| A-2 | Credentials (browser sessions, SSH keys, tokens, password stores) | Enable actions as the user elsewhere | Lateral compromise; the tactics boundary in the operator profile is explicit that unauthorized access trades a compounding asset for one payout |
| A-3 | The event log (`.db` + WAL) | The system of record; the only thing that can prove what happened | Loss of auditability; every later verification claim becomes unfalsifiable |
| A-4 | Canonical documents and the commit history | Project truth and provenance | Unrecoverable reasoning; silent architectural drift |
| A-5 | Backups (V, W, M-1, M-2-preflight) | Last line of defence | Loss of everything above, together |
| A-6 | The audit evidence (`.lain-audit`) | Historical measurement record | Findings become unverifiable |
| A-7 | Machine availability (CPU, VRAM, disk) | On 4 cores / 6 GB VRAM, a runaway process degrades the whole machine | Denial of the user's own work; not a security breach, but a real cost |
| A-8 | Lain's own integrity (its policy, its grants, its logs) | A system that can rewrite its own rules has no rules | Every other control becomes advisory |

## 3. Untrusted inputs and adversaries

| Source | Trust | What it can attempt |
|---|---|---|
| **Model output** (text, tool calls, arguments, generated code) | **Untrusted, always** | Prompt injection from any file it reads; a tool call that names `C:\Users\frick\.ssh`; code that tries to escape; a plausible-sounding reason to skip a check |
| **Tool processes** (node, git, python, third-party binaries) | **Untrusted executor** | Anything the user account can do, unless the OS says otherwise; writing outside the workspace via a redirect; spawning children that outlive it |
| **Third-party content** (web pages, repositories, documents) | **Untrusted data** | Carrying injected instructions into the model's context |
| **The model file itself** | Untrusted at the integrity level: a digest is checked, but a compromised model produces hostile output | Same as model output, with more capability |
| **The user** | **Trusted operator** | May authorize anything, including things that are unwise; not an adversary in this model |
| **Lain's own components** | Trusted only as far as their tests | A bug in the store or policy is a vulnerability, not merely a defect |

**In scope:** accidental and careless damage by a confused or manipulated agent; a prompt-injected instruction that tries to widen its own authority; a tool that ignores its contract; process leaks; a controller crash mid-task.
**Explicitly out of scope for M-2:** kernel or driver exploits; a local administrator attacker; physical access; supply-chain compromise of Node/Git/Python themselves; multi-user or remote threats; defence against a determined human adversary with time and skill. Recording these as non-goals is not a loophole — it is what keeps the in-scope claims testable.

## 4. Trust boundaries

| # | Boundary | Crossing is allowed only by | Enforcement (not a promise) |
|---|---|---|---|
| B-1 | Model → controller | A validated tool-call schema | Deterministic validation; malformed calls are refused, never repaired |
| B-2 | Controller → Policy Engine | A request for a decision | Total `decide()`; default arm `deny`; no call path bypasses it |
| B-3 | Policy → execution layer | An `allow` decision with a `decision_id` | Execution refuses to run without a recorded decision id |
| B-4 | Execution → tool process | Job Object + restricted token + Low IL workspace | OS-enforced; measured for the write direction |
| B-5 | Tool → filesystem | MIC on the object | Verified for writes outside the workspace; **reads unrestricted (known gap)** |
| B-6 | Tool → network | **Nothing today** | **Unenforced. Declared out of scope for M-2.** |
| B-7 | Tool → UI/COM | **Nothing today** | **Not tested; MIC does not address it** |
| B-8 | Anything → event store | The store's own write API | Single write transaction at a time; redaction on write; controller-only handle |
| B-9 | Anything → canonical documents / grants / policy | An explicit, recorded human decision | No runtime path writes them; the store has no authorization role |

## 5. Attack surfaces

1. **Tool arguments** — the highest-frequency surface: every path, glob, command line and flag the model produces.
2. **Tool stdout/stderr** — returned as content and therefore an injection vector *and* a secret-leak vector (redaction applies to what is persisted; see A-3/A-2).
3. **Generated code** — even when it is only "run the test", it is code the model wrote. M-2 runs it only at Low IL in a labelled workspace.
4. **The workspace itself** — if a task inherits a previous task's workspace, it inherits its reparse points and leftovers. One workspace per task, created fresh.
5. **Job Object assignment** — a tool that can create its own job can leave descendants outside the outer job (see [dotnet/runtime#107992](https://github.com/dotnet/runtime/issues/107992)). Surfaced as a defect, never ignored.
6. **Approval prompts** — the classic failure is a prompt that can be answered *for* the user. Absence of approval is denial; a timeout is `deny_indeterminate`, which is never retried.
7. **The store's sidecar files** — `<db>.writer.json` and `.writer.lock` are diagnostics only; if they ever became authority, a hand-edited PID would grant write access.

## 6. Security objectives, each with its test

| # | Objective | How it is proven |
|---|---|---|
| O-1 | A tool cannot write outside its workspace | Denied-write tests with the artefact confirmed absent, plus the allowed write in the same run (Verification E pattern) |
| O-2 | No process survives a cancelled or crashed task | Tree enumeration after cancel; kill-on-close test with a killed controller |
| O-3 | No action executes without a recorded decision | Store-boundary check plus a test that the execution layer refuses without a `decision_id` |
| O-4 | Secrets never reach the store | Byte-level scan of the database, WAL and SHM |
| O-5 | The record survives a crash and marks what it cannot prove | Existing AT-M1-13/14/15 tests plus `indeterminate[]` in the result schema |
| O-6 | The agent cannot widen its own authority | Capability set fixed at admission; a widening attempt is refused and recorded |
| O-7 | Cancellation never reports success it cannot prove | `cancel_failed`/`escalated` distinct from `cancelled` |

## 7. Mitigations and residual risks

| Threat | Mitigation | Residual risk that remains |
|---|---|---|
| Prompt-injected instruction to write elsewhere | MIC refuses; path validation fast-fails first | A Low-labelled location elsewhere on the volume is still writable |
| Injected instruction to read credentials | **None** | **Reads are unrestricted by MIC — this is the largest single gap** |
| Tool ignores its contract and phones home | **None** | Network is unenforced |
| Tool drives the desktop | **None** | UI/COM untested and unaddressed by MIC |
| Tool spawns a surviving child | Job Object with no breakaway + post-cancel enumeration | An intermediate process creating its own job can still leave descendants |
| Runaway memory/CPU | Job limits are available in the API | **Not implemented; configured limits are unverified** |
| Malformed or malicious tool output | Structured results, redaction on write | The model can still be misled by content it reads; the defence is that being misled cannot grant authority |
| Controller crash mid-task | `KILL_ON_JOB_CLOSE` | The task is `indeterminate` until reconciled, which is correct but requires a human or a policy to resolve |

## 8. What an attacker with the agent's authority could actually do today

Stated plainly, because it is the only honest way to size the residual risk: an agent whose proposed actions were all permitted could **read any file the user can read** (including credentials), **write inside its own workspace freely**, **reach the network**, and **run code** — while being unable to write outside its workspace, unable to survive cancellation, and unable to change its own permissions. The two gaps that matter most are therefore **reads** and **network**, in that order, and the mitigations for both are either AppContainer/LPAC (unmeasured) or scope decisions the user makes deliberately.

## 9. Open questions

| # | Question | Blocks |
|---|---|---|
| OQ-TM-1 | Is the read gap accepted for M-2 with a named limitation, or must it be closed first? | The containment claim, and the useful scope of the first tools |
| OQ-TM-2 | Is network use out of scope for M-2, or must a tool's network need be declared and enforced? | Any tool that fetches anything |
| OQ-TM-3 | Is a Low-labelled *shared* temp directory needed for the toolchain (npm/pip caches), and if so, what may live in it? | Practical tool execution; every shared writable region weakens O-1 |
| OQ-TM-4 | Who resolves an `indeterminate` outcome — the user, or a policy rule? | Recovery design in M-2.5 |
| OQ-TM-5 | Is `.lain-audit` write-protected for the agent's own processes, or only excluded by convention? | A-6 protection |
