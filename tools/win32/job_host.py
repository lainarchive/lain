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

  * The tool is created CREATE_SUSPENDED and assigned to the job before it is
    resumed, so there is no window in which it could run - or spawn a
    grandchild - outside the job. Resuming needs PROCESS_SUSPEND_RESUME in the
    OpenProcess mask; without 0x0800 NtResumeProcess returns 0xC0000022
    STATUS_ACCESS_DENIED and the child hangs forever with no error.

The result file is always written before this process exits, because exiting
closes the job handle and that is what kills the tree.

Lain is not a sandbox. This bounds resource use; it does not confine what a
tool is able to do.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as w
import json
import os
import subprocess
import sys
import threading
import time
import uuid

K = ctypes.WinDLL("kernel32", use_last_error=True)
NT = ctypes.WinDLL("ntdll")

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
K.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
K.OpenProcess.restype = w.HANDLE
K.CloseHandle.argtypes = [w.HANDLE]
K.CloseHandle.restype = w.BOOL
K.CreateIoCompletionPort.argtypes = [w.HANDLE, w.HANDLE, ctypes.c_size_t, w.DWORD]
K.CreateIoCompletionPort.restype = w.HANDLE
K.GetQueuedCompletionStatus.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD),
                                        ctypes.POINTER(ctypes.c_size_t),
                                        ctypes.POINTER(ctypes.c_void_p), w.DWORD]
K.GetQueuedCompletionStatus.restype = w.BOOL
NT.NtResumeProcess.argtypes = [w.HANDLE]
NT.NtResumeProcess.restype = ctypes.c_long

CREATE_SUSPENDED = 0x00000004
CREATE_NO_WINDOW = 0x08000000
PROCESS_TERMINATE = 0x0001
PROCESS_SET_QUOTA = 0x0100
PROCESS_SUSPEND_RESUME = 0x0800
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
    """Collect every job notification the completion port has queued."""
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
    return out


class Reader(threading.Thread):
    """Drain one pipe, keeping at most `cap` bytes and flagging any overflow."""

    def __init__(self, stream, cap: int):
        super().__init__(daemon=True)
        self.stream = stream
        self.cap = cap
        self.buf = bytearray()
        self.truncated = False

    def run(self) -> None:
        while True:
            chunk = self.stream.read(65536)
            if not chunk:
                break
            room = self.cap - len(self.buf)
            if room > 0:
                self.buf.extend(chunk[:room])
                if len(chunk) > room:
                    self.truncated = True
            else:
                self.truncated = True


def write_result(path: str, result: dict) -> None:
    """Write the result durably before anything can close the job handle."""
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(result, fh, indent=2, sort_keys=True)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


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

    cmd = [spec["command"], *spec.get("args", [])]
    env = spec.get("env") or None
    try:
        child = subprocess.Popen(
            cmd,
            cwd=spec.get("cwd") or None,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=CREATE_SUSPENDED | CREATE_NO_WINDOW,
        )
    except OSError as exc:
        out["spawn_error"] = f"{type(exc).__name__}: {exc}"
        # Keep the errno-shaped code the synchronous caller already reports, so
        # a missing executable still reads as ENOENT rather than a new word.
        out["spawn_error_code"] = "ENOENT" if isinstance(exc, FileNotFoundError) else "SPAWN_FAILED"
        out["fatal"] = "the tool process could not be created"
        out["duration_ms"] = int((time.time() - started) * 1000)
        return out

    out["pid"] = child.pid

    handle = K.OpenProcess(
        PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SUSPEND_RESUME, False, child.pid)
    if not handle:
        err = ctypes.get_last_error()
        child.kill()
        out["fatal"] = f"OpenProcess failed: {err}"
        out["duration_ms"] = int((time.time() - started) * 1000)
        return out

    assigned = K.AssignProcessToJobObject(job, handle)
    if not assigned:
        err = ctypes.get_last_error()
        K.CloseHandle(handle)
        child.kill()
        out["fatal"] = f"AssignProcessToJobObject failed: {err}"
        out["limits_refused"].append(
            {"limit": "job_membership", "code": err,
             "detail": "the tool was never placed in the job, so nothing was enforced"})
        out["duration_ms"] = int((time.time() - started) * 1000)
        return out

    # Only now, with the tool already inside the job, is it allowed to run.
    resume = int(NT.NtResumeProcess(handle))
    K.CloseHandle(handle)
    if resume != 0:
        K.TerminateJobObject(job, EXIT_QUOTA_EXCEEDED)
        out["fatal"] = (f"NtResumeProcess failed: 0x{resume & 0xFFFFFFFF:08X} "
                        f"(PROCESS_SUSPEND_RESUME must be in the OpenProcess mask)")
        out["duration_ms"] = int((time.time() - started) * 1000)
        return out

    cap = int(spec.get("output_bytes") or 1_048_576)
    readers = [Reader(child.stdout, cap), Reader(child.stderr, cap)]
    for reader in readers:
        reader.start()

    supervisor_ms = int(spec.get("supervisor_ms") or 300_000)
    deadline = started + supervisor_ms / 1000.0
    exit_code = None
    while True:
        exit_code = child.poll()
        if exit_code is not None:
            break
        if any(r.truncated for r in readers):
            # The tool has already written more than the ceiling allows. Stop
            # the whole job rather than let it keep producing into a discard.
            out["kill_reason"] = "output_ceiling"
            K.TerminateJobObject(job, EXIT_QUOTA_EXCEEDED)
            try:
                exit_code = child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                exit_code = child.poll()
            break
        if time.time() > deadline:
            out["kill_reason"] = "supervisor_timeout"
            K.TerminateJobObject(job, EXIT_QUOTA_EXCEEDED)
            try:
                exit_code = child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                exit_code = child.poll()
            break
        time.sleep(0.01)

    for reader in readers:
        reader.join(timeout=5)

    out["exit_code"] = None if exit_code is None else exit_code & 0xFFFFFFFF
    out["stdout"] = readers[0].buf.decode("utf-8", errors="replace")
    out["stderr"] = readers[1].buf.decode("utf-8", errors="replace")
    out["output_truncated"] = readers[0].truncated or readers[1].truncated
    out["notifications"] = drain_port(port, 0.6)
    out["ok"] = True
    out["duration_ms"] = int((time.time() - started) * 1000)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="run one tool process inside a job object")
    parser.add_argument("--spec", required=True, help="path to the spec JSON")
    parser.add_argument("--result", required=True, help="where to write the result JSON")
    parser.add_argument("--version", action="store_true", help="print the schema version and exit")
    args = parser.parse_args()

    if args.version:
        print("job_host/1")
        return 0

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
