"""Is JOB_OBJECT_LIMIT_BREAKAWAY_OK actually required to assign the child?

BREAKAWAY_OK costs containment: a process inside a job that carries it may
leave by asking to, when it is created with CREATE_BREAKAWAY_FROM_JOB. So it
should only be set if the assignment genuinely fails without it.

Runs the identical suspended-start path twice and reports the difference.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as w
import subprocess
import sys

K = ctypes.WinDLL("kernel32", use_last_error=True)
NT = ctypes.WinDLL("ntdll")

K.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
K.CreateJobObjectW.restype = w.HANDLE
K.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
K.OpenProcess.restype = w.HANDLE
K.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
K.AssignProcessToJobObject.restype = w.BOOL
K.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
K.SetInformationJobObject.restype = w.BOOL
K.CloseHandle.argtypes = [w.HANDLE]
NT.NtResumeProcess.argtypes = [w.HANDLE]
NT.NtResumeProcess.restype = ctypes.c_long

CREATE_SUSPENDED = 0x00000004
PROCESS_SET_QUOTA = 0x0100
PROCESS_TERMINATE = 0x0001
PROCESS_SUSPEND_RESUME = 0x0800
BREAKAWAY_OK = 0x00000800
KILL_ON_JOB_CLOSE = 0x00002000


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


def attempt(label: str, flags: int) -> dict:
    job = K.CreateJobObjectW(None, None)
    info = EXTENDED_LIMIT()
    info.BasicLimitInformation.LimitFlags = flags
    info.ProcessMemoryLimit = 256 * 1024 * 1024
    set_ok = K.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))

    child = subprocess.Popen([sys.executable, "-c", "print('ran')"],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             creationflags=CREATE_SUSPENDED)
    hand = K.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SUSPEND_RESUME,
                         False, child.pid)
    assigned = K.AssignProcessToJobObject(job, hand)
    assign_err = ctypes.get_last_error()
    resume = int(NT.NtResumeProcess(hand)) if assigned else None
    K.CloseHandle(hand)

    ran = None
    if resume == 0:
        try:
            out, _ = child.communicate(timeout=10)
            ran = out.decode(errors="replace").strip()
        except subprocess.TimeoutExpired:
            child.kill()
            ran = "HUNG"
    print(f"{label:<26} set_ok={bool(set_ok)} assign={bool(assigned)} "
          f"assign_err={assign_err} resume={resume} child_said={ran!r}")
    return {"label": label, "assigned": bool(assigned), "ran": ran}


def main() -> int:
    a = attempt("breakaway_ok=yes", KILL_ON_JOB_CLOSE | BREAKAWAY_OK)
    b = attempt("breakaway_ok=no", KILL_ON_JOB_CLOSE)
    print()
    print(f"assignment needs BREAKAWAY_OK: {b['assigned'] is False}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
