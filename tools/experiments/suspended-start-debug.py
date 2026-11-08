"""Narrow down why a suspended child did not resume inside the job.

Reports each step's status instead of blocking, so a failure is a value rather
than a hang.
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
NT.NtResumeProcess.argtypes = [w.HANDLE]
NT.NtResumeProcess.restype = ctypes.c_long

CREATE_SUSPENDED = 0x00000004
PROCESS_TERMINATE = 0x0001
PROCESS_SET_QUOTA = 0x0100
PROCESS_SUSPEND_RESUME = 0x0800
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800


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


def main() -> int:
    job = K.CreateJobObjectW(None, None)
    print(f"job_created={bool(job)} err={ctypes.get_last_error()}")

    info = EXTENDED_LIMIT()
    info.BasicLimitInformation.LimitFlags = (
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK)
    ok = K.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
    print(f"set_info={bool(ok)} err={ctypes.get_last_error()}")

    child = subprocess.Popen([sys.executable, "-c", "print('ran')"],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             creationflags=CREATE_SUSPENDED)
    print(f"spawned pid={child.pid}")

    # Does the child really not run while suspended?
    try:
        child.wait(timeout=1.0)
        print("PROBLEM: suspended child exited on its own")
        return 1
    except subprocess.TimeoutExpired:
        print("still_alive_while_suspended=True (expected)")

    for access, label in ((PROCESS_SET_QUOTA | PROCESS_TERMINATE, "set_quota|terminate"),
                          (PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SUSPEND_RESUME,
                           "set_quota|terminate|suspend_resume")):
        hand = K.OpenProcess(access, False, child.pid)
        print(f"open_process[{label}]={bool(hand)} err={ctypes.get_last_error()}")
        if not hand:
            continue
        assigned = K.AssignProcessToJobObject(job, hand)
        err = ctypes.get_last_error()
        print(f"  assign={bool(assigned)} err={err}")
        resumed = NT.NtResumeProcess(hand)
        print(f"  NtResumeProcess status={resumed} (0 == success)")
        K.CloseHandle(hand)
        if resumed == 0:
            break

    try:
        out, errout = child.communicate(timeout=8)
        print(f"child_out={out!r} child_err={errout!r} exit={child.returncode}")
    except subprocess.TimeoutExpired:
        print("STILL HUNG after resume — terminating")
        child.kill()
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
