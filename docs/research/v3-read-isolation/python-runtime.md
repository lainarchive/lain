# The Python runtime the container is allowed to read

The container cannot read `C:\Python315`. That directory is owned by SYSTEM and
Administrators with `BUILTIN\Users:(OI)(CI)(RX)` and nothing else, and the grant
we need is refused:

```
> icacls C:\Python315 /grant "*S-1-15-2-4156793909-...(OI)(CI)RX"
C:\Python315: Access is denied.
```

The before and after `icacls C:\Python315` listings are byte-identical — the same
three ACEs — so the interpreter on this machine was left untouched. A copy is not
a convenience here; it is the only way a containerised Python can exist at all.

Node needs none of this. `node.exe` is self-contained, and the EXE image is
opened with the *parent's* rights, so it starts from an ungranted directory. The
import DLLs are a different story: they are opened by the child, in the
container's context. `python.exe` without `python315.dll` is the measured proof —
`exit_code 3221225781`, `STATUS_DLL_NOT_FOUND`.

## What is actually required

Measured by building the tree and running it in the container, not by reading the
installer's manifest.

| Tree | Bytes | Result in the container |
| --- | --- | --- |
| `C:\Python315` as installed | 191,948,675 | works — but the container cannot read it |
| minimal copy, 682 files | 40,042,257 | `IMPORTS-OK 3.15.0` |
| minimal copy without `DLLs/` | 20,277,537 | `print` and `import json` OK; `import ssl` fails |

The minimal copy is 20.8% of the installed size. The import battery it passes is:

```python
import json, sys, ssl, ctypes, sqlite3, hashlib, socket, decimal, email, http.client, zipfile, unittest
```

Dropped, with the reason each one is droppable:

| Component | MB | Why it can go |
| --- | --- | --- |
| `Doc/` | 78.7 | documentation |
| `Lib/test/` | 35.2 | CPython's own test suite |
| `DLLs/` | — | **kept**, see below |
| `Lib/site-packages/` | 11.1 | nothing is installed into this runtime |
| `tcl/` | 2.8 | tkinter |
| `include/` | 2.4 | C headers, build time only |
| `NEWS.txt` | 2.4 | changelog |
| `Lib/ensurepip/` | 1.8 | pip bootstrap |
| `Lib/idlelib/` | 1.6 | IDLE |
| `Lib/__pycache__/` | 3.0 | bytecode cache, regenerated on first import |
| `Lib/pydoc_data/` | 1.2 | `pydoc` topics |
| `libs/` | 0.8 | import libraries, build time only |
| `Scripts/` | 0.3 | console entry points for installed packages |
| `pythonw.exe`, `Lib/turtledemo/` | 0.1 | no windowed interpreter, no turtle demos |

`DLLs/` is 18.8 MB of the 38.2 MB that remains, so it is the obvious next cut. It
is kept because dropping it is measurable and it breaks: `print` still works,
`import json` still works, and `import ssl` dies with

```
ModuleNotFoundError: Standard library module '_ssl' was not found
```

`_ssl` is a C extension that lives in `DLLs/`. Which of the ~40 modules in there
are unnecessary is **not determined** — I did not measure them one at a time, and
guessing would put a number in this document that nothing supports. A per-module
sweep is the obvious follow-up and would remove most of the 18.8 MB.

What remains in the minimal tree:

| Component | MB |
| --- | --- |
| `DLLs/` | 18.8 |
| `Lib/` | 11.4 |
| `python315.dll` | 7.5 |
| `vcruntime140.dll`, `python.exe`, `python3.dll`, `abi3t-compat/` | 0.5 |

One line of stderr is expected and harmless:

```
Failed to find real location of C:\Users\frick\AppData\Local\Lain\runtimes\python315\python.exe
```

That is `getpath` reporting a relocated interpreter. It is printed by a runtime
that then exits 0 and passes the battery, so it is a cosmetic warning and not a
provisioning failure. It is worth knowing because a reader who greps stderr for
"Failed" will find it on every healthy run.

## Where it lives

```
%LOCALAPPDATA%\Lain\runtimes\python315\
```

Not `%TEMP%`. A temp copy is a thing that vanishes and takes every Python tool
with it; a runtime directory is prepared once, recorded, and can be checked. It
is outside the repository and outside every workspace, and it is granted
`(OI)(CI)RX` to the container SID — read and execute, never write, because the
tool has no business rewriting its own interpreter.

The directory name carries the version, so an upgrade lands beside the old one
rather than on top of it.

## The hash inventory

682 files, and a manifest digest over the sorted `sha256  relpath` lines:

```
manifest_sha256 = 549bdb194d21974acfdfe6101f44b829af38f3eb684df87f7ea6cf6319feb572
```

The digest is the thing to record, not the 682 lines. It answers "is this runtime
the one that was measured" in one comparison, and it is stable across machines
because the paths are relative.

## Provisioning

```
robocopy C:\Python315 <runtime> /E /XD Doc include libs Scripts tcl test idlelib \
    ensurepip pydoc_data __pycache__ site-packages turtledemo /XF pythonw.exe NEWS.txt
icacls <runtime> /grant "*<container-sid>:(OI)(CI)RX"
```

**`robocopy` exits 1 on success.** Its codes are 0 = nothing to do, 1 = files
copied, 8 and above = failure. A provisioning script that tests `exit == 0`
throws away every good copy it ever makes — the same shape as the truncated
script that exits 0 and the empty pipe that reads as a silent child.

## Upgrade

1. Build the new tree beside the old one, under its own versioned name.
2. Run the import battery **in the container**, not on the host. A runtime that
   imports on the host and not in the container is the failure this whole
   document exists to prevent, and it is exactly what a missing ACE produces.
3. Compare the manifest digest with the recorded one.
4. Point the helper at the new directory. The old one stays until the new one has
   passed.

## When it is missing

It is a reported refusal, not a fallback. The helper selects the interpreter by
explicit absolute path with no PATH search, and a path that is not there is
`INTERPRETER_MISSING` on the result — an empty `limits_applied`, empty output,
and no tool process. Nothing degrades into running unconfined, because a missing
runtime must never turn into a run without a boundary.

## Not determined

- Which `DLLs/` modules beyond `_ssl` are load-bearing, and how much of the
  18.8 MB survives a per-module sweep.
- Whether a zipped stdlib (`python315.zip`) works under the container. Not tried.
- Whether an extension that loads a further DLL from a granted directory works
  when that directory is granted `RX` only. `_ssl` and `_sqlite3` both loaded,
  which is evidence that the ordinary case works, not that every case does.
- Python versions other than 3.15.0. The build is 64-bit, `MSC v.1951`.
