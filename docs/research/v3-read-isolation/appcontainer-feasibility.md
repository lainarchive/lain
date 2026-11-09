# Read isolation: what was measured, and what it costs

V-3 set out to make a tool process unable to read the user's files, enforced by the
kernel rather than by a path check in the runner. This file records the measurements
that decided the design, including the two mechanisms that turned out to be closed
and the one that works.

Every number here came from a probe in `tools/experiments/`, run on this machine.
Where something could not be determined it says so rather than rounding up.

## The account we are running as

`kirb\lain`, SID `S-1-5-21-3412152243-2925446466-2272665338-1001`, Medium integrity,
**not elevated**, with a filtered token: `BUILTIN\Administrators` (S-1-5-32-544) and
S-1-5-114 are present as **"Group used for deny only"**, so they cannot be re-enabled.

`whoami /priv` lists seven privileges. The two that matter for launching a process
under another identity are **absent**:

| Privilege | Needed by | State here |
| --- | --- | --- |
| `SeIncreaseQuotaPrivilege` | `CreateProcessAsUser` | **not held** |
| `SeImpersonatePrivilege` | `CreateProcessWithTokenW` | **not held** |
| `SeAssignPrimaryTokenPrivilege` | `CreateProcessAsUser` (some paths) | held but Disabled, and cannot be enabled on a filtered token |

That single fact closes a whole family of designs, which is why it is the first
thing in this document rather than a footnote.

## Closed: restricted tokens (`tools/experiments/restricted-token-probe.py`)

`CreateRestrictedToken` **succeeds** in all three shapes tried — `WRITE_RESTRICTED`
(0x8) with `BUILTIN\Users` as a restricting SID, `DISABLE_MAX_PRIVILEGE` (0x1), and
`WRITE_RESTRICTED` with no restricting SIDs — and **every** `CreateProcessAsUserW`
then returns `winerror 5, "Access is denied."`

This is not a probe defect. It is the privilege table above: `CreateProcessAsUser`
wants `SeIncreaseQuotaPrivilege`, the account does not have it, and the token is
filtered so it cannot be acquired. The documented exception for tokens built by
`CreateRestrictedToken` does not rescue it here.

**Consequence: no restricted-token design is available unelevated on this machine.**
Anything that needs a token the user's own processes do not hold needs an
administrator.

## Open: AppContainer (`tools/experiments/appcontainer-probe.py`)

AppContainer takes a different path — `CreateProcess` with
`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` — which needs **none** of the
privileges above. Measured:

- **`CreateAppContainerProfile` works unelevated.** On first use `hr == S_OK` and the
  profile is created. A rerun returns `0x800700B7`, win32 **183**
  `ERROR_ALREADY_EXISTS` — and that error is itself evidence, because the kernel only
  reports a collision after it has looked. An earlier reading of this probe took
  `0x800700B7` for a refused registry write and concluded the opposite; the
  correction is recorded here because the wrong version had already been believed
  once.
- **`DeriveAppContainerSidFromAppContainerName` succeeds** and is deterministic:
  profile `lain.v3.probe` → `S-1-15-2-3694883704-2882623137-3138763234-80483366-3560209170-2232522940-1602020101`.
  No administrator anywhere on this path.
- **`icacls <dir> /grant *<sid>:(OI)(CI)RX` works unelevated** on a directory the
  user owns.

### What a running Node inside the container can read

Measured from inside a live container, with the parent's own reads as the control:

| Path | Result |
| --- | --- |
| a directory explicitly granted to the container SID | **READ OK** |
| an ungranted sentinel in the same scratch tree | `EPERM` |
| `C:\Users\frick` | `EPERM` |
| `C:\Users\frick\.ssh` | `EPERM` |
| `C:\Users\frick\AppData\Local\Temp` | `EPERM` |
| `C:\Python315` | `EPERM` |
| `C:\Program Files\nodejs` (even `scandir`) | `EPERM` |
| `C:\Windows\win.ini` | **READ OK** |

So the boundary is ACL-shaped rather than a blanket denial: world-readable files
stay readable and the user's profile does not. That shape is the point — a boundary
that blocks everything is not a working boundary, and one is not claimed here.

**The denial code is `EPERM`, errno `-4048`,** not `EACCES` and not `ENOENT`. That
is the exact string a tool author will see, and the distinction matters: `ENOENT`
would let a tool conclude the file does not exist, which is a different and more
misleading report than "you may not read this".

### The interpreters

Node runs with no preparation at all. The `.exe` image is opened and mapped with the
**parent's** rights, so any tool starts regardless of the container; the import DLLs
are what the child opens in its own context, and `node.exe` is self-contained.

**Python does not, and the reason is the interesting one.** `python.exe` from
`C:\Python315` dies with `exit 0xC0000135 STATUS_DLL_NOT_FOUND`, because it needs
`python315.dll` beside it and the container has no read grant on that directory. The
remedy was proved rather than reasoned: copying `C:\Python315` to a directory the
user owns, granting the container SID `(OI)(CI)RX` on the copy, and re-running gave
`exit_code 0` and `python alive 3.15.0`.

**`C:\Python315` itself cannot be granted** — `icacls` returns "Access is denied"
because SYSTEM and Administrators own it, and a before/after ACE listing confirmed
the ACL is byte-identical after the attempt. So the design offers Python through a
**copied interpreter directory under Lain's own state directory**, prepared once and
recorded, rather than modifying the system's interpreter.

### What this costs the supervisor

The existing supervisor can launch the tool itself: `CreateProcessW` +
`STARTUPINFOEX` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` needs no new
privilege and no second helper process, and no restricted token has to be handed
anywhere.

One V-2 wart disappears as a side effect: `CreateProcessW` returns the thread handle,
so `CREATE_SUSPENDED` + `ResumeThread` replaces the `NtResumeProcess` call that
needed `PROCESS_SUSPEND_RESUME` (0x0800) and hung forever without it. The
spawn-then-assign race closes properly instead of being narrowed.

## A trap worth recording, because it cost an hour

An AppContainer has **no access to the parent's pipe handles**. A child given a pipe
for stdout runs and writes nothing, and an empty output is indistinguishable from a
child that never ran. The first version of the read probe reported `exit_code 0` with
empty output for both the control and the container run and looked like a pass.

The diagnostic that settled it (`tools/experiments/appcontainer-diagnostic.py`) runs
`cmd.exe /c echo PLUMBING-OK` with **no container involved** and got `exit_code 1`
with empty output — which made six simultaneous container results meaningless at
once. The lesson is not "use a file instead of a pipe"; it is that **every probe
needs its positive control in the same run**, because a boundary that denies
everything and a probe that works on nothing produce identical output.

## Standard streams: files, not pipes

The supervisor opens an output **file** with `CreateFileW` (GENERIC_WRITE,
`FILE_SHARE_READ`, an explicit security descriptor) and passes that handle as
`hStdOutput` and `hStdError` in the `STARTUPINFOEX` buffer, at the documented x64
offsets — dwFlags 60, `hStdInput` 80, `hStdOutput` 88, `hStdError` 96, with the
attribute-list pointer after the 104-byte `STARTUPINFO`.

That choice is forced by the pipe finding above and it pays twice. There is no parent
pipe handle for the container to be denied, so the child's output arrives; and there
is no backpressure, so a tool that writes heavily cannot deadlock against a supervisor
that is not reading. **A child that exits without writing leaves an empty file — a
file the supervisor opened, which is a fact, not an absence.** That is the difference
between "the tool produced nothing" and "the wire never worked", and it is the only
reason a bounded-output claim is checkable at all.

## Network: MEASURED, and the container has none — including loopback

`tools/experiments/appcontainer-network-probe.mjs` (jobs-runner's, which drives the
real supervisor with a real spec twice — plain, then with
`container: 'lain.tool.runner'`). The program is handed over `-e` so no file has to be
readable for the run to start, every case prints `NET-MARKER` first, and the spec
carries `expect_marker`, so an empty output is a refusal rather than a silent pass.
That closes the pipe trap at the seam instead of inside the probe.

```
--- plain: ok exit=0 ---
NET-MARKER
loopback=CONNECTED in 3ms | internet-ip=TIMEOUT in 4001ms | dns=RESOLVED:104.20.23.154
--- container: ok exit=0 ---
NET-MARKER
loopback=ERROR:ETIMEDOUT in 306ms | internet-ip=ERROR:EACCES in 0ms | dns=ERROR:ENOTFOUND
```

Both runs `ok`, both exit 0, both with the marker present, so both results are facts
rather than absences. Reading them with the three categories kept apart:

- **OS-enforced denial:** `internet-ip=ERROR:EACCES in 0ms`. Refused by the operating
  system at zero elapsed time — a denial, not a timeout, and the **0 ms is what
  distinguishes them**. A timed-out connection would mean the packet left.
- **The control that makes it a measurement:** `loopback=CONNECTED in 3ms` plain
  against `ERROR:ETIMEDOUT in 306ms` in the container. A listener on this machine is
  reachable without the container and is not reachable with it, so the harness can
  demonstrably observe a success and the container demonstrably cannot produce one.
- **DNS:** `RESOLVED:104.20.23.154` plain, `ERROR:ENOTFOUND` in the container — name
  resolution fails rather than resolving and then failing to connect.
- **Not a Lain result, and not to be quoted as one:** the plain run's
  `internet-ip=TIMEOUT in 4001ms` is this machine's own egress being filtered. The
  control that matters is the loopback line.

So the AppContainer has **no network at all — not the internet, not loopback, not
DNS** — and the internet case is a hard `EACCES` rather than a hang. This is a second
confinement that the read-isolation brief did not ask for, and it is stated as its own
answer because "the tool cannot read outside its workspace" reads weaker than what is
actually true.

## What is not determined here

- Whether `AssignProcessToJobObject` still applies to a container process, and
  whether `KILL_ON_JOB_CLOSE` still reaps the tree under it. **Answered since this was
  written**: every container run posts `NEW_PROCESS x2`, `EXIT_PROCESS x2` and
  `ACTIVE_PROCESS_ZERO`, and `taskkill /F /PID <supervisor>` with **no** `/T` reaps the
  containerised tool (`AT-V2-JOB-03`). The two boundaries compose.
- The setup cost of launching into a container, in milliseconds. **Answered for the
  trivial case**: 4 runs of the same `node -e` gave plain 704/735/737/718 ms (avg
  723.5) and contained 732/730/718/728 ms (avg 727), so **+3.5 ms**. A tool that loads
  more libraries may cost more; one measurement is one measurement.
- The failure mode when the profile cannot be resolved. **Answered**: it refuses with
  `CONTAINER_UNAVAILABLE` / `the AppContainer profile ... does not exist`, before the
  tool is resumed, and `AT-V2-JOB-10` covers the sibling case of a containerised run
  with no `LOCALAPPDATA`.
- Whether a granted workspace lets the tool *write* as well as read, and which right is
  the narrowest that works. **Answered**: `(OI)(CI)M`. `RX` cannot write; `M` is
  narrower than `F` because it excludes `WRITE_DAC` and `WRITE_OWNER`, so the tool
  cannot change the ACL that confines it. `(RX,W)` was rejected because a tool that
  cannot rename its own temporary file is broken rather than confined.
- Network behaviour under the container — **answered above**: no internet, no
  loopback, no DNS, with the internet case a hard `EACCES` at 0 ms rather than a
  timeout. What is still open is whether *inherited network handles* or a child
  process could reach the network by another route; neither was tested.
- Hard links, alternate data streams, and already-open handles. Not tested. A hard link
  created *before* the boundary existed points at the same object and the ACL that
  denies the target denies the link, but that is reasoning, not a measurement, and it
  is not claimed here.

## The honest summary

**Kernel-enforced read isolation is achievable on this machine without administrator
rights, through AppContainer, for Node and for a copied Python.** It was not
achievable through restricted tokens, and the reason is a privilege the account does
not hold and cannot acquire.

What that does **not** mean: it does not make Lain a sandbox. The workspace is still
the only write boundary, network is still policy-only, `C:\Windows` remains readable,
and the container needs read grants on interpreter directories to start at all. The
sentence that survives every measurement in this file is the one already in
`SECURITY_MODEL.md`: **Lain is not a sandbox.**
