# 05 — Low-Integrity Toolchain Experiment

**Status:** **PASS** for the tested write boundary and the tested toolchain operations, with explicitly untested aspects carried forward.
**Date:** 2026-11-08
**Scope:** can the development toolchain (Node, Git, Python) perform ordinary bounded work inside a Windows Low-Integrity workspace — and is the write boundary real while it does?
**Independent?** Yes. The experiment was designed for this assignment, uses positive **and** negative controls per restriction, and was run non-elevated in a disposable `%TEMP%` path. **This is an experiment, not a security certification**, and it does not authorize M-2.

## Why this was the gate

M-1 recorded a verified containment *mechanism* (restricted token + Mandatory Integrity Control: 9 of 11 escape classes contained, 2 not testable, 0 escapes) but never measured whether an ordinary toolchain survives the boundary. A containment boundary that breaks `node`, `git` and `python` is unusable; one that lets them write anywhere is worthless. The question M-2 cannot proceed without is therefore *both at once*: does legitimate work succeed **and** does an escape fail?

## Setup

- Harness written fresh for this run in `%TEMP%\lain-verifyE`:
  - `LowIlToolchain.cs` — P/Invoke `OpenProcessToken`, `DuplicateTokenEx`, `CreateRestrictedToken`, `ConvertStringSidToSidW`, `SetTokenInformation(TokenIntegrityLevel)`, `CreateProcessAsUserW`; compiled with the in-box `csc.exe` (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319`).
  - `low-probe.ps1` — the child, recording ALLOW / DENY / NOT-TESTABLE per operation.
  - a narrow `followup.ps1`.
- **Non-elevated throughout.** No system security setting was changed. No credential was read. No user document was touched. No network access was attempted.
- Directories: a lab directory labelled `(OI)(CI)(NW)` Low, plus deliberately **unlabelled** (thus Medium) sibling directories for the negative controls, all under `%TEMP%`.
- Token flags: `DISABLE_MAX_PRIVILEGE | LUA_TOKEN` plus `TokenIntegrityLevel = Low` (`S-1-16-4096`).

## Three findings that each produced a wrong result first

1. **`WRITE_RESTRICTED` with an empty restricting-SID list silently breaks the toolchain.** The first child returned exit **0** while doing nothing at all: `CreateProcessAsUserW` succeeded, no file was created, no output appeared. Rebuilding the token without that flag made the identical child perform every operation. Any conclusion drawn from the first run would have been "the toolchain cannot work at Low IL" — the opposite of the truth, and caused by one flag whose name suggests it only narrows writes.
2. **The child needs a fully qualified executable path.** `CreateProcessAsUserW` with bare `powershell.exe` failed `error=2 ERROR_FILE_NOT_FOUND` even though the parent's `PATH` contains its directory; the absolute path `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe` works. A launcher must resolve executables itself rather than rely on inherited `PATH` resolution inside the new process.
3. **`icacls <dir> /setintegritylevel (OI)(CI)Low` labels the directory and future children, not files that already exist.** Pre-existing files had to be labelled individually, otherwise they stay Medium and the child cannot write them — a failure that looks like a toolchain problem and is actually a labelling gap.

## Evidence that the boundary was actually applied

Every file the child created carries a Low mandatory label: `created.txt`, `node-out.txt`, `hello.mjs`, `gitrepo\f.txt`, `low-probe-results.txt` → `Mandatory Label\Low Mandatory Level:(I)(NW)`. The lab directory itself is `(OI)(CI)(NW)`. So the child was demonstrably Low, not merely launched as Low.

## Allowed operations (positive controls — all inside the Low workspace)

| Operation | Result |
|---|---|
| Read a file inside the workspace | allowed — returned `seed-content` |
| Create a file inside the workspace | allowed (22 B) |
| Modify a file inside the workspace | allowed (32 B) |
| Run a Node 24.21.0 script | allowed — script ran and wrote its output |
| Run a Python 3.15.0 script | allowed — script ran and wrote its output |
| Git 2.56 `init` + `config` + `add` + `commit` | allowed — commit created (`log: 217f15f probe`), full `.git` object store written at Low IL |
| Spawn a child process from Node | allowed (`rc=0 out=42`) |
| Read project-local configuration bytes | allowed |

## Denied operations (negative controls)

| Attempted escape | Result | Artefact present on disk afterwards |
|---|---|---|
| Write to an unlabelled sibling directory under the same `%TEMP%` parent | refused | `escape.txt` **False** |
| Write to a second unlabelled `%TEMP%` parent | refused | `escape2.txt` **False** |
| Write to a third unlabelled directory (`lain-lowil-minilab`) | refused | `write-mini.txt` **False** |
| Write directly in the `%TEMP%` root | refused | `%TEMP%\lain-temp-root.txt` **False** |
| **Control:** the same write *inside* the workspace | **allowed** | present |

The positive control matters as much as the denials: it proves the refusals came from the boundary rather than from a broken child.

## What is NOT contained — stated plainly

- **Reads are not restricted by Mandatory Integrity Control.** A file outside the workspace was readable by the Low child, and the child could read anything the user account can read. MIC is a write-integrity mechanism, not a confidentiality mechanism.
- **Other Low-labelled locations remain writable** from anywhere on the volume.
- **UI/COM escalation was not tested** (out of scope, and it would require a separate authorization).
- **Network reachability was not tested.** No connection was attempted; nothing about network containment is claimed.
- **Resource limits were not tested** — no CPU, memory, disk or handle ceiling was applied to the child.
- The native `CreateFileW` probe returned **NOT-TESTABLE** inside the child: `Add-Type` fails at Low IL because Roslyn compiles into a Medium-integrity `%TEMP%`, so the in-child P/Invoke integrity read could not be compiled. The denial evidence therefore rests on managed exceptions (`MethodInvocationException` wrapping `UnauthorizedAccessException`) plus the **independent** confirmation that no escape artefact exists on disk. A raw Win32 error code was not obtained at Low IL, and is not claimed.
- One anomaly is recorded rather than explained away: `Set-Content` to `$env:TEMP\<name>.tmp` reported success while no such file existed afterwards. The most likely cause is that the path resolved into the child's current directory (the lab, which is writable) or that the write was absorbed. It is **not** counted as an escape, and it is not counted as a verified containment either.

## Cleanup

The lab contents were written to `%TEMP%\lain-verifyE\lab-contents-before-cleanup.txt` (**56 entries**) **before** any deletion. Exactly three directories were removed — each verified to be a `lain-lowil-*` leaf directly under `%TEMP%` (`lain-lowil-lab`, `lain-lowil-control`, `lain-lowil-minilab`) — and all three were confirmed gone afterwards. The repository working tree was unchanged by the experiment, and no protected location was touched.

## Conclusion

**PASS**, scoped precisely: Node, Git and Python perform ordinary bounded development work inside a Low-Integrity workspace, and writes outside that workspace are refused — including into Medium-integrity locations under the same parent directory. The read-access limit and the untested UI/COM, network and resource-limit properties are **prerequisites for M-2**, not verified properties.

A successful toolchain experiment does not authorize M-2. It removes one blocker and sharpens the next decision.
