"""Supervise exactly one tool run inside a Windows job object.

    python job_host.py --spec <spec.json> --result <result.json>

Why this is a supervisor and not a launcher: the job handle is held here, and
the job is created with KILL_ON_JOB_CLOSE. If this process dies for any reason
- crash, taskkill, machine-level teardown - the kernel closes the handle and
reaps every process still in the job. The tool tree cannot outlive its watcher
by accident, and Node only ever has to kill one pid.

Shape, and why it is this shape (both points were measured, see
tools/experiments/job-limit-probe.py):

  * The supervisor stays OUTSIDE the job and the tool is assigned to it.
    JOB_OBJECT_LIMIT_JOB_TIME accounts the whole job, so a supervisor that
    joined its own job would be terminated at the same instant as the tool and
    could never report what happened. Measured: assign=self with a 1000 ms
    ceiling killed the supervisor itself and no result was written at all.

  * The tool is created CREATE_SUSPENDED, assigned to the job, and only then
    resumed, so there is no window in which it could run - or spawn a
    grandchild - outside the job. CreateProcessW hands back the thread handle,
    so ResumeThread does this directly. V-2 launched with Popen, which keeps no
    thread handle, and had to reach for NtResumeProcess; that needed
    PROCESS_SUSPEND_RESUME (0x0800) in the OpenProcess mask or it returned
    0xC0000022 STATUS_ACCESS_DENIED and hung the child with no error anywhere.

The tool is also launched inside an AppContainer, so a read outside the granted
directories fails at the kernel instead of being discouraged. Nothing in the
result is taken from the tool's own account of itself: the exit code, the job's
own limit notifications, and a marker the caller asked for are what decide.

The result file is always written before this process exits, because exiting
closes the job handle and that is what kills the tree.

Lain is not a sandbox. This bounds resource use and denies reads outside the
granted directories; it does not confine what a tool is able to do.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as w
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid

K = ctypes.WinDLL("kernel32", use_last_error=True)

K.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
K.CreateJobObjectW.restype = w.HANDLE
K.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
K.AssignProcessToJobObject.restype = w.BOOL
K.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
K.SetInformationJobObject.restype = w.BOOL
K.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD,
                                        ctypes.POINTER(w.DWORD)]
K.QueryInformationJobObject.restype = w.BOOL
K.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
K.TerminateJobObject.restype = w.BOOL
K.CloseHandle.argtypes = [w.HANDLE]
K.CloseHandle.restype = w.BOOL
K.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
K.TerminateProcess.restype = w.BOOL
K.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
K.WaitForSingleObject.restype = w.DWORD
K.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
K.GetExitCodeProcess.restype = w.BOOL
K.CreateIoCompletionPort.argtypes = [w.HANDLE, w.HANDLE, ctypes.c_size_t, w.DWORD]
K.CreateIoCompletionPort.restype = w.HANDLE
K.GetQueuedCompletionStatus.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD),
                                        ctypes.POINTER(ctypes.c_size_t),
                                        ctypes.POINTER(ctypes.c_void_p), w.DWORD]
K.GetQueuedCompletionStatus.restype = w.BOOL

CREATE_SUSPENDED = 0x00000004
CREATE_NO_WINDOW = 0x08000000
WAIT_TIMEOUT = 258
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

JOB_OBJECT_LIMIT_PROCESS_TIME = 0x00000002
JOB_OBJECT_LIMIT_JOB_TIME = 0x00000004
JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000

JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
JOB_OBJECT_ASSOCIATE_COMPLETION_PORT_INFORMATION = 7

EXIT_QUOTA_EXCEEDED = 0xC0000044

# The job telling us it is empty. Nothing about this run can arrive after it, so
# drain_port stops there rather than sleeping out its whole budget.
MSG_ACTIVE_PROCESS_ZERO = 4

MSG_NAMES = {
    1: "END_OF_JOB_TIME",
    2: "END_OF_PROCESS_TIME",
    3: "ACTIVE_PROCESS_LIMIT",
    4: "ACTIVE_PROCESS_ZERO",
    6: "NEW_PROCESS",
    7: "EXIT_PROCESS",
    8: "ABNORMAL_EXIT_PROCESS",
    9: "PROCESS_MEMORY_LIMIT",
    10: "JOB_MEMORY_LIMIT",
    11: "NOTIFICATION_LIMIT",
    12: "JOB_CYCLE_TIME_LIMIT",
    13: "SILO_TERMINATED",
}

# Which ceiling each limit notification is evidence for.
KILL_BY_NOTIFICATION = {
    "END_OF_JOB_TIME": "job_time",
    "END_OF_PROCESS_TIME": "job_time",
    "PROCESS_MEMORY_LIMIT": "process_memory",
    "JOB_MEMORY_LIMIT": "job_memory",
}


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class BASIC_LIMIT(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", w.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", w.DWORD),
        ("Affinity", ctypes.POINTER(ctypes.c_ulong)),
        ("PriorityClass", w.DWORD),
        ("SchedulingClass", w.DWORD),
    ]


class EXTENDED_LIMIT(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", BASIC_LIMIT),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class ASSOCIATE_COMPLETION_PORT(ctypes.Structure):
    _fields_ = [("CompletionKey", ctypes.c_void_p), ("CompletionPort", w.HANDLE)]


# --- the AppContainer half ----------------------------------------------------
#
# The tool is launched inside an AppContainer, which is what makes a read
# outside the workspace fail instead of merely being discouraged.
# CreateProcessW with a security-capabilities attribute needs no
# SeIncreaseQuotaPrivilege; the whole CreateProcessAsUser family does, and that
# family is dead on this machine (winerror 5 for every token shape).
#
# Measured, and it explains a failure that looks like a bug: the EXE image is
# opened and mapped with the PARENT's rights, so a tool always starts. The
# import DLLs are opened by the child in the container's context. node.exe is
# self-contained and runs from an ungranted directory; python.exe needs
# python315.dll beside it and exits 0xC0000135 STATUS_DLL_NOT_FOUND unless that
# directory is granted to the container SID. C:\Python315 belongs to SYSTEM and
# Administrators and cannot be granted by us, so the Python runtime is a copy we
# own - see src/exec/runtime.mjs, which prepares it once and records the path.

CONTAINER_NAME = "lain.tool.runner"
ERROR_ALREADY_EXISTS = 183
HRESULT_ALREADY_EXISTS = 0x80070000 | ERROR_ALREADY_EXISTS
STATUS_DLL_NOT_FOUND = 0xC0000135

EXTENDED_STARTUPINFO_PRESENT = 0x00080000
STARTF_USESTDHANDLES = 0x00000100
CREATE_UNICODE_ENVIRONMENT = 0x00000400
PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009
GENERIC_WRITE = 0x40000000
FILE_SHARE_READ = 0x00000001
CREATE_ALWAYS = 2


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Sid", w.LPVOID), ("Attributes", w.DWORD)]


class SECURITY_CAPABILITIES(ctypes.Structure):
    _fields_ = [
        ("AppContainerSid", w.LPVOID),
        ("Capabilities", ctypes.POINTER(SID_AND_ATTRIBUTES)),
        ("CapabilityCount", w.DWORD),
        ("Reserved", w.DWORD),
    ]


class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [("StartupInfo", ctypes.c_byte * 104), ("lpAttributeList", w.LPVOID)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE),
                ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


class SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("nLength", w.DWORD), ("lpSecurityDescriptor", w.LPVOID),
                ("bInheritHandle", w.BOOL)]


U = ctypes.WinDLL("userenv", use_last_error=True)
A = ctypes.WinDLL("advapi32", use_last_error=True)

U.CreateAppContainerProfile.argtypes = [
    w.LPCWSTR, w.LPCWSTR, w.LPCWSTR, ctypes.POINTER(SID_AND_ATTRIBUTES), w.DWORD,
    ctypes.POINTER(w.LPVOID)]
U.CreateAppContainerProfile.restype = w.HRESULT
U.DeriveAppContainerSidFromAppContainerName.argtypes = [w.LPCWSTR, ctypes.POINTER(w.LPVOID)]
U.DeriveAppContainerSidFromAppContainerName.restype = w.HRESULT
A.ConvertSidToStringSidW.argtypes = [w.LPVOID, ctypes.POINTER(w.LPWSTR)]
A.ConvertSidToStringSidW.restype = w.BOOL
A.ConvertStringSidToSidW.argtypes = [w.LPCWSTR, ctypes.POINTER(w.LPVOID)]
A.ConvertStringSidToSidW.restype = w.BOOL
K.InitializeProcThreadAttributeList.argtypes = [
    w.LPVOID, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)]
K.UpdateProcThreadAttribute.argtypes = [
    w.LPVOID, w.DWORD, ctypes.c_size_t, w.LPVOID, ctypes.c_size_t, w.LPVOID,
    ctypes.POINTER(ctypes.c_size_t)]
K.CreateProcessW.argtypes = [
    w.LPCWSTR, w.LPWSTR, w.LPVOID, w.LPVOID, w.BOOL, w.DWORD, w.LPVOID, w.LPCWSTR,
    w.LPVOID, ctypes.POINTER(PROCESS_INFORMATION)]
K.CreateProcessW.restype = w.BOOL
K.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
K.CreateFileW.restype = w.HANDLE
K.ResumeThread.argtypes = [w.HANDLE]
K.ResumeThread.restype = w.DWORD


def sid_text(sid) -> str | None:
    out = w.LPWSTR()
    if A.ConvertSidToStringSidW(sid, ctypes.byref(out)):
        text = out.value
        K.LocalFree(out)
        return text
    return None


def container_sid(name: str) -> tuple[object, dict]:
    """The AppContainer SID for `name`.

    Lain creates exactly one profile - its own - and derives every other name.
    Creating whatever name it was handed made a typo into a new, empty boundary
    that still reported itself as a container, which is fail-open wearing the
    right answer's clothes.

    A None SID means the run must refuse. Falling through to a plain spawn would
    run the tool with no boundary while the result still claimed one, which is
    worse than not running it.

    `name` may also be the SID itself, because the caller usually resolved the
    profile already and handing the SID back to be resolved again is not the same
    operation. Measured: `DeriveAppContainerSidFromAppContainerName` on a string
    that is already a SID returns 0x80070057, so a workspace granted to A would
    have tried to run as B.
    """
    report: dict = {}
    sid = w.LPVOID()
    if name.startswith("S-1-15-2-"):
        if not A.ConvertStringSidToSidW(name, ctypes.byref(sid)):
            report["code"] = "CONTAINER_SID_INVALID"
            report["detail"] = f"'{name}' is not a SID this process can convert"
            return None, report
        report["sid"] = sid_text(sid)
        report["from_sid_string"] = True
        return sid, report
    if name == CONTAINER_NAME:
        hr = U.CreateAppContainerProfile(
            name, "Lain tool runner", "runs Lain tool processes", None, 0, ctypes.byref(sid))
        if hr == 0:
            report["created"] = True
            report["sid"] = sid_text(sid)
            return sid, report

        code = hr & 0xFFFFFFFF
        report["create_hr"] = f"0x{code:08X}"
        if code == HRESULT_ALREADY_EXISTS:
            # Only a caller that got far enough to look can be told this.
            report["already_existed"] = True
        else:
            signed = code - 0x100000000 if code >= 0x80000000 else code
            report["create_message"] = ctypes.FormatError(signed).strip()
    else:
        report["derived_only"] = True

    derived = w.LPVOID()
    hr2 = U.DeriveAppContainerSidFromAppContainerName(name, ctypes.byref(derived))
    if hr2 != 0:
        report["derive_hr"] = f"0x{hr2 & 0xFFFFFFFF:08X}"
        return None, report
    report["sid"] = sid_text(derived)
    return derived, report


def attribute_list(sid) -> tuple[object, object, int]:
    """A PROC_THREAD_ATTRIBUTE list carrying the security capabilities.

    Returns (buffer, sec, 0) or (None, None, winerror). The caller must keep
    `sec` alive until CreateProcessW has consumed it: the attribute list holds a
    POINTER to it, and letting it be collected produces an access violation
    inside CreateProcessW instead of an error anyone can read.
    """
    sec = SECURITY_CAPABILITIES()
    sec.AppContainerSid = sid
    sec.Capabilities = None
    sec.CapabilityCount = 0
    sec.Reserved = 0
    size = ctypes.c_size_t(0)
    K.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
    if not size.value:
        return None, None, ctypes.get_last_error()
    buffer = ctypes.create_string_buffer(size.value)
    if not K.InitializeProcThreadAttributeList(buffer, 1, 0, ctypes.byref(size)):
        return None, None, ctypes.get_last_error()
    if not K.UpdateProcThreadAttribute(
            buffer, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            ctypes.byref(sec), ctypes.sizeof(sec), None, None):
        return None, None, ctypes.get_last_error()
    return buffer, sec, 0


def output_handle(path: str) -> tuple[object, int]:
    """A writable handle the child inherits.

    The parent opens it, so the container's own ACL never enters into it: the
    child writes through a handle that already carries the access. This is the
    deliberate answer to the empty-pipe trap - an AppContainer cannot reach the
    parent's pipe handles, so a piped child writes nothing and empty output
    cannot be told apart from a child that never ran.
    """
    sa = SECURITY_ATTRIBUTES()
    sa.nLength = ctypes.sizeof(sa)
    sa.lpSecurityDescriptor = None
    sa.bInheritHandle = True
    handle = K.CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, ctypes.byref(sa),
                           CREATE_ALWAYS, 0, None)
    if handle == INVALID_HANDLE_VALUE:
        return None, ctypes.get_last_error()
    return handle, 0


def set_limits(job, spec: dict) -> tuple[dict, list, list]:

    """Ask for each ceiling, then read back what the kernel actually holds.

    A BOOL from SetInformationJobObject is a claim; the query is the evidence.
    Requested ceilings that the kernel did not retain are reported as refused
    rather than quietly assumed to be in force.
    """
    info = EXTENDED_LIMIT()
    flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    wanted: list[str] = []

    process_memory = spec.get("process_memory_bytes")
    if process_memory:
        flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY
        info.ProcessMemoryLimit = int(process_memory)
        wanted.append("process_memory")

    job_memory = spec.get("job_memory_bytes")
    if job_memory:
        flags |= JOB_OBJECT_LIMIT_JOB_MEMORY
        info.JobMemoryLimit = int(job_memory)
        wanted.append("job_memory")

    job_ms = spec.get("job_ms")
    if job_ms:
        flags |= JOB_OBJECT_LIMIT_JOB_TIME
        info.BasicLimitInformation.PerJobUserTimeLimit = int(job_ms) * 10_000
        wanted.append("job_time")

    info.BasicLimitInformation.LimitFlags = flags
    ok = K.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                                   ctypes.byref(info), ctypes.sizeof(info))
    set_err = None if ok else ctypes.get_last_error()

    back = EXTENDED_LIMIT()
    returned = w.DWORD(0)
    queried = K.QueryInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                                          ctypes.byref(back), ctypes.sizeof(back),
                                          ctypes.byref(returned))
    held = back.BasicLimitInformation.LimitFlags if queried else 0

    applied: list[str] = []
    refused: list[dict] = []
    checks = [
        ("process_memory", JOB_OBJECT_LIMIT_PROCESS_MEMORY),
        ("job_memory", JOB_OBJECT_LIMIT_JOB_MEMORY),
        ("job_time", JOB_OBJECT_LIMIT_JOB_TIME),
    ]
    if not ok:
        for name in wanted:
            refused.append({"limit": name, "code": set_err or 0,
                            "detail": f"SetInformationJobObject failed: {set_err}"})
        return {}, applied, refused

    if queried and not (held & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE):
        refused.append({"limit": "kill_on_close", "code": 0,
                        "detail": "KILL_ON_JOB_CLOSE was not retained by the job"})

    for name, flag in checks:
        if name not in wanted:
            continue
        if queried and not (held & flag):
            refused.append({"limit": name, "code": 0,
                            "detail": f"the job did not retain {name} after it was set"})
        else:
            applied.append(name)

    readback = {
        "queried": bool(queried),
        "limit_flags": int(held),
        "kill_on_close": bool(held & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE),
        "process_memory_limit": int(back.ProcessMemoryLimit),
        "job_memory_limit": int(back.JobMemoryLimit),
        "per_job_user_time_limit_ticks": int(back.BasicLimitInformation.PerJobUserTimeLimit),
    }
    return readback, applied, refused


def drain_port(port, budget_s: float) -> list:
    """Collect every job notification the completion port has queued.

    ACTIVE_PROCESS_ZERO is the job saying it holds no process at all, and no
    notification about this run can follow it, so the loop ends there. Waiting
    out the budget instead cost 600 ms on every run - measured, a trivial
    `node -e` took 863 ms of which the tool itself was 79 ms. The budget stays as
    the bound for a job that never empties.
    """
    out: list[dict] = []
    deadline = time.time() + budget_s
    while time.time() < deadline:
        code = w.DWORD(0)
        key = ctypes.c_size_t(0)
        ov = ctypes.c_void_p(None)
        ok = K.GetQueuedCompletionStatus(port, ctypes.byref(code), ctypes.byref(key),
                                         ctypes.byref(ov), 60)
        if not ok:
            if ctypes.get_last_error() == WAIT_TIMEOUT:
                continue
            break
        value = int(code.value)
        out.append({"msg": value, "name": MSG_NAMES.get(value, f"UNKNOWN_{value}"),
                    "pid": int(key.value)})
        if value == MSG_ACTIVE_PROCESS_ZERO:
            break
    return out


def write_result(path: str, result: dict) -> None:
    """Write the result durably before anything can close the job handle."""
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(result, fh, indent=2, sort_keys=True)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def build_env_block(env) -> object:
    if not env:
        return None
    text = "".join(f"{key}={value}\0" for key, value in env.items()) + "\0"
    return ctypes.create_unicode_buffer(text)


def apply_env_for_container(env) -> None:
    """Put `env` into our own environment block and hand the child nothing.

    CreateProcessW refuses a caller-supplied environment for an AppContainer:
    every non-NULL block comes back ERROR_ENVVAR_NOT_FOUND (203), even a single
    dummy variable. Measured 2026-11-08: {A: B} and {SystemRoot: ...} both fail,
    an empty block succeeds only because it is dropped to NULL.

    With lpEnvironment NULL the child inherits THIS process's environment -
    measured at 64 variables, including USERPROFILE, APPDATA and a variable set
    only in the probe. So the allow-list is applied here, one step earlier:
    clearing this process's block means the inherited one is the allow-list.
    """
    os.environ.clear()
    os.environ.update({str(key): str(value) for key, value in env.items()})


def wait_exit(handle, timeout_s: float = 0.0):
    """The exit code once the process has finished, else None."""
    if K.WaitForSingleObject(handle, int(timeout_s * 1000)) == WAIT_TIMEOUT:
        return None
    code = w.DWORD()
    if not K.GetExitCodeProcess(handle, ctypes.byref(code)):
        return None
    return code.value


def file_size(path: str) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def read_capped(path: str, cap: int) -> tuple[str, int]:
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError:
        return "", 0
    return data[:cap].decode("utf-8", errors="replace"), len(data)


def spawn_tool(spec: dict, job, scratch: str) -> tuple[object, dict]:
    """Create the tool suspended, put it in the job, then let it run.

    Everything that can refuse does so before the tool is resumed, so a refusal
    never leaves a running process behind and never leaves the caller believing
    a boundary was applied when it was not.
    """
    out: dict = {"pid": None, "container": None}
    sid = None
    container = spec.get("container")
    if container:
        sid, report = container_sid(container)
        out["container"] = report
        if sid is None:
            out["fatal"] = "the tool container could not be resolved"
            out["code"] = "CONTAINER_UNAVAILABLE"
            return None, out

    buffers = None
    sec = None
    if sid is not None:
        buffers, sec, winerror = attribute_list(sid)
        if buffers is None:
            out["fatal"] = f"UpdateProcThreadAttribute failed: {winerror}"
            out["code"] = "CONTAINER_ATTRIBUTE_FAILED"
            return None, out

    stdout_path = os.path.join(scratch, "stdout.txt")
    stderr_path = os.path.join(scratch, "stderr.txt")
    out_handle, err_out = output_handle(stdout_path)
    err_handle, err_err = output_handle(stderr_path)
    if out_handle is None or err_handle is None:
        if out_handle is not None:
            K.CloseHandle(out_handle)
        if err_handle is not None:
            K.CloseHandle(err_handle)
        out["fatal"] = f"the output files could not be opened: {err_out or err_err}"
        out["code"] = "OUTPUT_FILE_FAILED"
        return None, out

    si = STARTUPINFOEXW()
    ctypes.memset(ctypes.byref(si), 0, ctypes.sizeof(si))
    # cb is the size of the whole STARTUPINFOEX when EXTENDED_STARTUPINFO_PRESENT
    # is passed: 104 is sizeof(STARTUPINFO) on x64 plus the attribute pointer.
    ctypes.cast(ctypes.byref(si), ctypes.POINTER(w.DWORD))[0] = ctypes.sizeof(si)
    if buffers is not None:
        si.lpAttributeList = ctypes.cast(buffers, w.LPVOID)
    # The struct is opaque here, so the std handles are written at their x64
    # offsets: dwFlags 60, hStdInput 80, hStdOutput 88, hStdError 96.
    ctypes.cast(ctypes.byref(si, 60), ctypes.POINTER(w.DWORD))[0] = STARTF_USESTDHANDLES
    ctypes.cast(ctypes.byref(si, 80), ctypes.POINTER(w.HANDLE))[0] = INVALID_HANDLE_VALUE
    ctypes.cast(ctypes.byref(si, 88), ctypes.POINTER(w.HANDLE))[0] = out_handle
    ctypes.cast(ctypes.byref(si, 96), ctypes.POINTER(w.HANDLE))[0] = err_handle

    cmd = [spec["command"], *spec.get("args", [])]
    cmdline = ctypes.create_unicode_buffer(subprocess.list2cmdline(cmd))
    env_block = build_env_block(spec.get("env"))
    if sid is not None and spec.get("env") is not None:
        if "LOCALAPPDATA" not in spec["env"]:
            # Fail with the reason rather than with Windows' own wording, which
            # reads as a typo in the block and sends the reader looking for one.
            out["fatal"] = ("a containerised run needs LOCALAPPDATA: CreateProcessW "
                            "rejects any environment block without it with "
                            "ERROR_ENVVAR_NOT_FOUND (203), whatever else the block holds")
            out["code"] = "CONTAINER_ENV_INCOMPLETE"
            return None, out
        apply_env_for_container(spec["env"])
        env_block = None
    flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
    if buffers is not None:
        flags |= EXTENDED_STARTUPINFO_PRESENT
    pi = PROCESS_INFORMATION()
    created = K.CreateProcessW(
        None, cmdline, None, None, True, flags,
        ctypes.cast(env_block, w.LPVOID) if env_block is not None else None,
        spec.get("cwd") or None, ctypes.byref(si), ctypes.byref(pi))
    err = ctypes.get_last_error()
    K.CloseHandle(out_handle)
    K.CloseHandle(err_handle)
    if not created:
        out["spawn_error"] = ctypes.FormatError(err).strip()
        # Keep the errno-shaped code the synchronous caller already reports, so
        # a missing executable still reads as ENOENT rather than a new word.
        out["spawn_error_code"] = "ENOENT" if err == 2 else "SPAWN_FAILED"
        out["fatal"] = "the tool process could not be created"
        if sid is not None and err == 2:
            # DeriveAppContainerSidFromAppContainerName hashes the name and
            # succeeds for a profile that does not exist, so the missing thing
            # here is the profile's own storage and not the executable. Without
            # this the run would refuse with no reason attached, and "nothing
            # ran" is not the same report as "the boundary was not available".
            out["code"] = "CONTAINER_PROFILE_MISSING"
            out["fatal"] = f"the AppContainer profile {spec.get('container')!r} does not exist"
        return None, out

    out["pid"] = pi.dwProcessId
    if not K.AssignProcessToJobObject(job, pi.hProcess):
        assign_err = ctypes.get_last_error()
        K.TerminateProcess(pi.hProcess, EXIT_QUOTA_EXCEEDED)
        K.CloseHandle(pi.hThread)
        K.CloseHandle(pi.hProcess)
        out["fatal"] = f"AssignProcessToJobObject failed: {assign_err}"
        out["code"] = "JOB_ASSIGN_FAILED"
        return None, out

    # Only now, with the tool already inside the job, is it allowed to run.
    # CreateProcessW hands back the thread handle, which is what makes this
    # possible; Popen keeps no such handle and V-2 had to resort to
    # NtResumeProcess, which also needed PROCESS_SUSPEND_RESUME (0x0800) or it
    # hung the child with STATUS_ACCESS_DENIED and no error anywhere.
    if K.ResumeThread(pi.hThread) == 0xFFFFFFFF:
        resume_err = ctypes.get_last_error()
        K.TerminateProcess(pi.hProcess, EXIT_QUOTA_EXCEEDED)
        K.CloseHandle(pi.hThread)
        K.CloseHandle(pi.hProcess)
        out["fatal"] = f"ResumeThread failed: {resume_err}"
        return None, out

    K.CloseHandle(pi.hThread)
    out["stdout_path"] = stdout_path
    out["stderr_path"] = stderr_path
    return pi.hProcess, out


def supervise(spec: dict) -> dict:
    started = time.time()
    job_name = f"lain-tool-{uuid.uuid4().hex[:12]}"
    out: dict = {
        "ok": False,
        "pid": None,
        "job_name": job_name,
        "limits_applied": [],
        "limits_refused": [],
        "stdout": "",
        "stderr": "",
        "output_truncated": False,
        "output_unverified": False,
        "exit_code": None,
        "notifications": [],
        "kill_reason": None,
        "readback": {},
        "spawn_error": None,
        "fatal": None,
        "duration_ms": 0,
    }

    job = K.CreateJobObjectW(None, job_name)
    if not job:
        out["fatal"] = f"CreateJobObjectW failed: {ctypes.get_last_error()}"
        return out

    # The handle is deliberately never closed. Exiting closes it, and that is
    # what reaps the tree; closing it early would kill the tool mid-run.
    port = K.CreateIoCompletionPort(INVALID_HANDLE_VALUE, None, 0, 0)
    if port:
        assoc = ASSOCIATE_COMPLETION_PORT()
        assoc.CompletionKey = ctypes.c_void_p(0)
        assoc.CompletionPort = port
        K.SetInformationJobObject(job, JOB_OBJECT_ASSOCIATE_COMPLETION_PORT_INFORMATION,
                                  ctypes.byref(assoc), ctypes.sizeof(assoc))

    readback, applied, refused = set_limits(job, spec)
    out["readback"] = readback
    out["limits_applied"] = applied
    out["limits_refused"] = refused

    scratch = spec.get("scratch") or tempfile.mkdtemp(prefix="lain-job-")
    process, spawn = spawn_tool(spec, job, scratch)
    out["container"] = spawn.get("container")
    if process is None:
        out["spawn_error"] = spawn.get("spawn_error")
        out["spawn_error_code"] = spawn.get("spawn_error_code")
        out["fatal"] = spawn["fatal"]
        if spawn.get("code"):
            limit = "container" if spawn["code"].startswith("CONTAINER") else "job_membership"
            out["limits_refused"].append(
                {"limit": limit, "code": spawn["code"], "detail": spawn["fatal"]})
        out["duration_ms"] = int((time.time() - started) * 1000)
        return out

    out["pid"] = spawn["pid"]
    cap = int(spec.get("output_bytes") or 1_048_576)
    supervisor_ms = int(spec.get("supervisor_ms") or 300_000)
    deadline = started + supervisor_ms / 1000.0
    exit_code = None
    while True:
        exit_code = wait_exit(process)
        if exit_code is not None:
            break
        # The tool has already written more than the ceiling allows. Stop the
        # whole job rather than let it keep producing into a discard.
        if file_size(spawn["stdout_path"]) > cap or file_size(spawn["stderr_path"]) > cap:
            out["kill_reason"] = "output_ceiling"
            K.TerminateJobObject(job, EXIT_QUOTA_EXCEEDED)
            exit_code = wait_exit(process, 10.0)
            break
        if time.time() > deadline:
            out["kill_reason"] = "supervisor_timeout"
            K.TerminateJobObject(job, EXIT_QUOTA_EXCEEDED)
            exit_code = wait_exit(process, 10.0)
            break
        time.sleep(0.01)
    K.CloseHandle(process)

    stdout_bytes_read, stdout_size = read_capped(spawn["stdout_path"], cap)
    stderr_bytes_read, stderr_size = read_capped(spawn["stderr_path"], cap)
    out["exit_code"] = None if exit_code is None else exit_code & 0xFFFFFFFF
    if out["exit_code"] == STATUS_DLL_NOT_FOUND:
        # Almost always the interpreter's own DLLs being unreadable to the
        # container, not a missing runtime.
        out["exit_name"] = "STATUS_DLL_NOT_FOUND"
    out["stdout"] = stdout_bytes_read
    out["stderr"] = stderr_bytes_read
    out["output_truncated"] = stdout_size > cap or stderr_size > cap
    out["notifications"] = drain_port(port, 0.6)

    # A run that produced nothing is the failure that cost an hour: an
    # AppContainer cannot reach the parent's pipe handles, so a piped child
    # writes nothing, and "no output" then looks exactly like "no run". When the
    # caller names a marker, a missing marker is reported, never quietly passed.
    marker = spec.get("expect_marker")
    if marker and marker not in out["stdout"]:
        out["output_unverified"] = True
        out["fatal"] = (f"the tool was expected to print {marker!r} and did not, so this run's "
                        "output is not evidence that it ran")
        out["duration_ms"] = int((time.time() - started) * 1000)
        return out

    out["ok"] = True
    out["duration_ms"] = int((time.time() - started) * 1000)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="run one tool process inside a job object")
    parser.add_argument("--spec", help="path to the spec JSON")
    parser.add_argument("--result", help="where to write the result JSON")
    parser.add_argument("--version", action="store_true", help="print the schema version and exit")
    # The workspace needs this SID to grant itself to the container before any
    # tool runs in it, and the SID is only knowable from here.
    parser.add_argument("--print-container-sid", action="store_true",
                        help="print the container SID, creating the profile if needed")
    args = parser.parse_args()

    if args.version:
        print("job_host/1")
        return 0

    if args.print_container_sid:
        sid, report = container_sid(CONTAINER_NAME)
        if sid is None:
            print(json.dumps(report), file=sys.stderr)
            return 2
        print(sid_text(sid))
        return 0

    if not args.spec or not args.result:
        parser.error("--spec and --result are required unless --version or --print-container-sid is given")

    try:
        with open(args.spec, encoding="utf-8") as fh:
            spec = json.load(fh)
    except (OSError, ValueError) as exc:
        write_result(args.result, {"ok": False, "fatal": f"unreadable spec: {exc}"})
        return 2

    try:
        result = supervise(spec)
    except Exception as exc:  # noqa: BLE001 - the result file must exist on every path
        result = {"ok": False, "fatal": f"{type(exc).__name__}: {exc}"}

    write_result(args.result, result)
    # Reaching here is what closes the job handle and reaps anything still in
    # the job. The result is already on disk, so nothing is lost by exiting.
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
