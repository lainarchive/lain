"""Measure what JOB_OBJECT_LIMIT_ACTIVE_PROCESS actually does.

The ceiling table has to say whether max_processes is enforced. The claim is
that the limit counts the process doing the spawning, so a limit of 1 starves
that process's own first child. This measures it instead of repeating it.

    C:\\Python315\\python.exe tools\\experiments\\active-process-probe.py
"""

import ctypes
import ctypes.wintypes as w
import json
import subprocess
import sys

K = ctypes.WinDLL("kernel32", use_last_error=True)

K.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
K.CreateJobObjectW.restype = w.HANDLE
K.GetCurrentProcess.argtypes = []
# Load-bearing: without restype = HANDLE the pseudo-handle is truncated to a
# signed int and every later call fails with ERROR_INVALID_HANDLE (6).
K.GetCurrentProcess.restype = w.HANDLE
K.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
K.AssignProcessToJobObject.restype = w.BOOL
K.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
K.SetInformationJobObject.restype = w.BOOL

JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x0008
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


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


def make_job(active_limit):
    job = K.CreateJobObjectW(None, None)
    if not job:
        raise OSError(ctypes.get_last_error(), "CreateJobObjectW")
    info = EXTENDED_LIMIT()
    info.BasicLimitInformation.LimitFlags = (
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    )
    info.BasicLimitInformation.ActiveProcessLimit = active_limit
    ok = K.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                                   ctypes.byref(info), ctypes.sizeof(info))
    if not ok:
        raise OSError(ctypes.get_last_error(), "SetInformationJobObject")
    return job


def case_assign_after_spawn():
    """Child is created OUTSIDE the job, then assigned to it."""
    job = make_job(1)
    proc = subprocess.Popen([sys.executable, "-c", "print('ran')"],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    ctypes.set_last_error(0)
    ok = K.AssignProcessToJobObject(job, w.HANDLE(int(proc._handle)))  # noqa: SLF001
    err = ctypes.get_last_error()
    out, errb = proc.communicate(timeout=30)
    return {
        "case": "assign_after_spawn",
        "active_process_limit": 1,
        "assign_ok": bool(ok),
        "assign_winerror": err,
        "child_exit": proc.returncode,
        "child_stdout": out.decode("utf-8", "replace").strip(),
        "child_stderr": errb.decode("utf-8", "replace").strip()[:200],
    }


def case_spawn_inside_job():
    """The spawning process is itself inside the job before it spawns."""
    job = make_job(1)
    ok = K.AssignProcessToJobObject(job, K.GetCurrentProcess())
    if not ok:
        return {"case": "spawn_inside_job", "self_assign_ok": False,
                "self_assign_winerror": ctypes.get_last_error()}
    ctypes.set_last_error(0)
    result = {"case": "spawn_inside_job", "self_assign_ok": True}
    try:
        proc = subprocess.Popen([sys.executable, "-c", "print('ran')"],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, errb = proc.communicate(timeout=30)
        result.update(spawn_ok=True, child_exit=proc.returncode,
                      child_stdout=out.decode("utf-8", "replace").strip())
    except OSError as exc:
        result.update(spawn_ok=False, spawn_winerror=getattr(exc, "winerror", None),
                      spawn_strerror=str(exc))
    return result


def main():
    findings = [case_assign_after_spawn(), case_spawn_inside_job()]
    print(json.dumps(findings, indent=2))


if __name__ == "__main__":
    main()
