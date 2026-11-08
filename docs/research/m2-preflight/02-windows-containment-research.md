# 02 — Windows Containment Research

**Status:** Research complete for the mechanisms that can be evaluated without an M-2 runtime. Recommendations are RECOMMENDED, not accepted.
**Date:** 2026-11-08
**Scope:** which Windows mechanisms Lain can actually rely on for containment on this machine and this OS build, what has been measured, what has not, and what the honest ceiling is.
**Verification classification:** VERIFIED (measured on this machine, this session or the recorded M-1/Phase 0 runs) · HISTORICAL (earlier audit measurement) · DOCUMENTED (official Microsoft documentation, cited) · UNRESOLVED · NOT-TESTABLE.

**The repository is not sandboxed, and no document may say it is.** The accurate sentence is in §6.

---

## 1. Mechanism-by-mechanism assessment

### 1.1 Integrity levels and Mandatory Integrity Control — **VERIFIED, load-bearing**

MIC evaluates access **before** the DACL and is purely a floor on writes: "a principal with a low integrity level cannot write to an object with a medium integrity level, even if that object's DACL allows write access" ([Mandatory Integrity Control](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)). Two properties from that page matter more than the headline:

- **"Objects that lack an integrity label are treated as medium by the operating system; this prevents low-integrity code from modifying unlabeled objects."** This is why the fix works without labelling the whole filesystem: only the *workspace* needs a Low label; everything else is already Medium by default. It is also why the boundary is asymmetric — see the limit below.
- **The mandatory policy is per-object and defaults to `NO_WRITE_UP`.** `SYSTEM_MANDATORY_LABEL_NO_READ_UP` exists and is **not** set by default, which is the documented reason reads are unrestricted.

Measured on this machine (M-1 Verification Closure, `05-low-integrity-toolchain-experiment.md`): a Low-IL child created files labelled `Low Mandatory Level:(I)(NW)`, ran Node 24.21.0, Python 3.15.0 and Git 2.56 (`init`/`add`/`commit`) inside a `(OI)(CI)(NW)`-labelled workspace, and was refused on **four** separate writes outside it, with every escape artefact confirmed absent on disk. Nine of eleven escape classes were contained by the Phase 0 E5 run (symlink, junction, hardlink, case variant, ADS, `\\?\`, `\\.\`, trailing dot, trailing space), including the decisive case that made path-based containment untenable: **a write through a hardlink is denied because MIC evaluates the object, not the path**.

**Limits, all measured or documented:** reads are not restricted; other Low-labelled locations remain writable; the boundary constrains only lower→higher integrity transitions, so it says nothing about a Low process's reach into other Low objects; and hardening the read direction requires `NO_READ_UP` per object, which would break ordinary tooling that reads its own runtime.

### 1.2 Restricted tokens — **VERIFIED as a capability, with a trap**

The restricted-token route (`CreateRestrictedToken`, `DISABLE_MAX_PRIVILEGE|LUA_TOKEN`, no restricting SIDs, plus `SetTokenInformation(TokenIntegrityLevel)` = Low) was measured to work **non-elevated** in Phase 0 (E3) and again in Verification E. The trap is a measured one: **`WRITE_RESTRICTED` with an empty restricting-SID list makes the child exit 0 while doing nothing at all** — `CreateProcessAsUserW` succeeds, no file is created, no output appears. A verification that only checked the exit code would have recorded a false pass.

### 1.3 Job Objects — **DOCUMENTED, mechanically the right tool for process containment and limits**

From [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) and [nested jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs):

- **Children join by default**, and containment is a deliberate choice of flags: with **neither** `JOB_OBJECT_LIMIT_BREAKAWAY_OK` nor `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` set, "the tool can monitor the entire process tree" and a child cannot break away. With `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, a child created with `CREATE_BREAKAWAY_FROM_JOB` escapes; with `SILENT_BREAKAWAY_OK`, it escapes without even needing the flag. **Lain should set neither**, and must then treat a tool that fails to assign its own job as a tool defect rather than ignoring the failure.
- **`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` makes the controller's death a cleanup event**: closing the last job handle terminates all associated processes. This is what makes cancellation work without cooperation from the tool, and what makes a controller crash leave no orphans.
- **Resource limits are real and per-job**, from [JOBOBJECT_BASIC_LIMIT_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information) and [JOBOBJECT_EXTENDED_LIMIT_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information): `JOB_OBJECT_LIMIT_PROCESS_MEMORY` (0x100, per-process committed memory), `JOB_OBJECT_LIMIT_JOB_MEMORY` (0x200, job-wide sum), `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` (0x8, maximum simultaneous processes — exceeding it **terminates** the process and fails the association), `JOB_OBJECT_LIMIT_PROCESS_TIME` (0x2) and `JOB_OBJECT_LIMIT_JOB_TIME` (0x4) as user-mode CPU-time limits in 100 ns ticks. In a nested job the effective limit is **the most restrictive in the chain**.
- **The documented escape is worth stating precisely:** a process that is *already* in a job can be added to another only if the hierarchy stays valid, and an intermediate process that creates its own job can leave descendants outside the outer job — the observed real-world case is the Windows Python launcher ([dotnet/runtime#107992](https://github.com/dotnet/runtime/issues/107992): "children of that child process will continue"). **Therefore the process-tree claim must always be verified by enumeration, never assumed from the flag.**
- **Nested jobs require Windows 8 / Server 2012 or later.** This machine is Windows 11 build 26200, so nesting is available — but Node itself may already be inside a job (the DSH harness is an Electron app), which is why the implementation must *test* assignment rather than assume it.

### 1.4 AppContainer and LPAC — **DOCUMENTED, the only mechanism that addresses the untested directions**

This is the mechanism the current design does **not** use, and the reason is scope, not doubt about its fitness. Per [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) and [implementing an AppContainer](https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/SecAuthZ/implementing-an-appcontainer.md), it provides exactly what MIC leaves open:

- **Network isolation:** "Granular access can be granted for Internet access, Intranet access, and acting as a server" — i.e. network access is opt-in by capability SID, which is the requirement §4 asks for and MIC cannot meet.
- **Window isolation:** "prevents the application from affecting other application interfaces" — the UI/COM boundary the current design leaves untested.
- **Process isolation** and **credential isolation**: the AppContainer "prevents the use of user credentials to gain access to resources or login to other environments", with a per-app identity, so a contained process cannot impersonate the user.
- **Dual-principal DACL semantics**: access is the **intersection** of the user's and the AppContainer's rights, so containment can only narrow, never widen, existing permissions.
- **LPAC** is stricter still — no registry access without the `registryRead` capability, no COM without `lpacCom`.

**Cost, stated honestly (UNRESOLVED — not measured here):** this is a larger step than it looks. It needs capability-SID derivation, DACL grants for the workspace, and a native helper Lain does not yet have; whether Node, Git and Python run correctly as LPAC is **unknown** and is a new experiment of the same shape as Verification E. **Do not assume it works because the documentation says it isolates things.**

### 1.5 Filesystem ACLs — **VERIFIED as a complement, not a boundary**

The Phase 0 S-2 measurement stands: path-based containment is insufficient on its own because hardlinks, junctions, symlinks, case variants, alternate data streams, `\\?\`, `\\.\` and trailing dot/space all defeat path checks — and a hardlink defeats `GetFinalPathNameByHandleW` too. **ACLs and integrity labels evaluate the object; path checks evaluate a string.** Lain's design must therefore put the enforcement on the object, and use path checks only as a fast rejection before the object is touched.

### 1.6 Network restriction — **UNENFORCED today**

Nothing in the current implementation restricts network access. A Low-IL process reaches the network exactly as the user does. The options, in ascending cost: (a) declare network use out of scope for M-2 and record the gap; (b) AppContainer with the internet-client capability withheld; (c) a filtering layer, which is a system-wide change and out of scope for a $0, no-elevation project. **RECOMMENDED for M-2: (a), recorded as a first-class limitation**, with the tool contract declaring whether a tool *needs* the network so that the decision is visible rather than assumed.

### 1.7 Credential isolation — **PARTLY VERIFIED**

Credentials do not enter model context and are not stored in the event store (redaction-on-write is verified: secrets never appear in the stored bytes, including WAL/SHM). A Low-IL process cannot write into Medium-integrity credential stores. What is **not** established: that a contained tool cannot *read* credentials the user can read, because reads are unrestricted by MIC and the AppContainer credential-isolation property is exactly what is missing from the current design.

## 2. What has been measured, and what has not

| Capability | Status | Evidence |
|---|---|---|
| Low-IL token derivation, non-elevated | **VERIFIED** | Phase 0 E3; Verification E |
| MIC write boundary inside a labelled workspace | **VERIFIED** | Verification E: 4 allowed ops, 4 denied escapes, artefacts absent |
| File objects created by a Low process carry Low IL | **VERIFIED** | `icacls` output on every created file |
| Node / Python / Git do bounded work at Low IL | **VERIFIED** | Verification E positive controls |
| 9 of 11 path/redirect escape classes contained | **VERIFIED (HISTORICAL)** | Phase 0 E5; 2 classes NOT-TESTABLE on this volume |
| Job Object kill-on-close semantics | **DOCUMENTED only** | Not exercised by any Lain code yet |
| Job memory / CPU-time / process-count limits | **DOCUMENTED only** | Flags exist; no Lain implementation |
| Read restriction | **NOT PRESENT** | Measured: outside file readable, `hosts` readable |
| Network restriction | **NOT PRESENT** | No mechanism attempted |
| UI/COM isolation | **NOT-TESTABLE in this design** | MIC does not address it; AppContainer claims to — unverified here |
| AppContainer / LPAC feasibility for the toolchain | **UNRESOLVED** | Not attempted; would be its own experiment |
| Resource limits in practice | **UNRESOLVED** | Nothing implemented |

## 3. Threat model summary

Full treatment in [03-threat-model.md](03-threat-model.md). The one-line version: **the untrusted input is the model's proposed action, and the untrusted executor is the tool process; neither may hold authority, so authority lives in the Policy Engine and enforcement lives in the OS objects the controller owns.**

## 4. The filesystem, process, network and credential boundaries

Specified in [04-filesystem-process-network-boundaries.md](04-filesystem-process-network-boundaries.md). The design rules that come out of §1:

1. **Enforce on the object, not the path.** Labelled workspace + restricted token; path checks are advisory fast-fail only.
2. **The controller owns the job handle for the whole task.** No breakaway flags; `KILL_ON_JOB_CLOSE` so a controller crash still cleans up.
3. **Verify, never assume.** Process-tree emptiness is enumerated after every cancellation; a tool that fails to join the job is a defect, not a detail.
4. **Declare what is not contained.** Reads, network, UI/COM and resource limits are named limitations, in the same sentence as the capabilities, everywhere the boundary is described.

## 5. Recommended architecture — two tiers, both honest

**Tier 1 (M-2 default), RECOMMENDED:** restricted token + Low IL workspace + Job Object with `KILL_ON_JOB_CLOSE`, memory/CPU/process-count limits set, no breakaway, network declared out of scope, reads declared unrestricted, UI/COM declared untested. Cost: it is the mechanism already measured, and it needs one native helper. It stops accidental and careless writes outside the workspace and it guarantees process-tree cleanup. It does not stop a determined attacker, and it does not stop credential reads.

**Tier 2 (later, RECOMMENDED as an explicit future option, not a promise):** AppContainer or LPAC, which is the mechanism that could actually deliver network and UI isolation and credential isolation. It should be attempted only as its own measured experiment, with the same positive/negative-control discipline as Verification E, because the documentation describes the *mechanism*, not Lain's ability to run a Node/Git/Python toolchain inside it.

**ESR — why Tier 1 is not merely the cheap option.** Every property Tier 1 claims has been measured on this machine. Tier 2's properties are documented but unmeasured here, and a boundary that has not been measured is exactly the class of claim that produced the container/VM defect (S-1) the audit had to correct.

## 6. The only sentence Lain may use

> Lain executes tools inside a low-integrity workspace with a restricted token, inside a Job Object that guarantees the process tree dies with the task. Writes outside the workspace are refused by Mandatory Integrity Control — measured against four escape attempts, and against nine redirect/path classes in an earlier run, with two classes not testable on this volume. **Reads are not restricted. Network access is not restricted. UI and COM are not isolated. Resource limits are configured but not yet verified.** Lain is not a sandbox.

Any stronger sentence is a defect. Any weaker sentence understates what was measured.
