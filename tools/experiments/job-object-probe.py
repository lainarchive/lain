"""Measure which Windows job-object limits actually work from CPython 3.15.

Question this answers: can Lain enforce `max_processes`, `max_wall_ms` and a
memory ceiling on a tool process using a job object, with no compiler, no
native addon and no bundled binary?

Design of the probe:
  * For each limit set, a CHILD python process creates the job, assigns itself,
    then tries to spawn grandchildren.
  * `JOB_OBJECT_LIMIT_BREAKAWAY_OK` is always set. Without it a job inside
    another job cannot assign a process at all (ERROR_ACCESS_DENIED), and a CI
    host or Windows Terminal is usually already a job. Whether the child USES
    the breakaway flag is what we then measure.
  * The parent measures: did the assignment work, did the first grandchild run,
    did a second grandchild get refused, how long until the job ended, and did
    the grandchild survive after the job handle closed.

Run:  python tools/experiments/job-object-probe.py
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as w
import json
import subprocess
import sys
import time

KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
KERNEL32.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
KERNEL32.CreateJobObjectW.restype = w.HANDLE
KERNEL32.GetCurrentProcess.argtypes = []
KERNEL32.GetCurrentProcess.restype = w.HANDLE
KERNEL32.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
KERNEL32.AssignProcessToJobObject.restype = w.BOOL
KERNEL32.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
KERNEL32.SetInformationJobObject.restype = w.BOOL
KERNEL32.CloseHandle.argtypes = [w.HANDLE]
KERNEL32.CloseHandle.restype = w.BOOL
KERNEL32.IsProcessInJob.argtypes = [w.HANDLE, w.HANDLE, ctypes.POINTER(w.BOOL)]
KERNEL32.IsProcessInJob.restype = w.BOOL

CREATE_BREAKAWAY_FROM_JOB = 0x01000000


def _pct(s):
    return ctypes.cast(s, ctypes.c_void_p).value


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


# Flags used by Lain's budget language.
JOB_OBJECT_LIMIT_PROCESS_TIME = 0x00000002
JOB_OBJECT_LIMIT_JOB_TIME = 0x00000004
JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008
JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800

JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
SECONDS = 10_000_000  # 100-nanosecond ticks

CASES = [
    ("bare", {}),
    ("kill_on_close", {"kill_on_close": True}),
    ("process_only", {"kill_on_close": True, "active_process": 1}),
    ("memory_only", {"kill_on_close": True, "process_memory_mb": 256}),
    ("job_memory_only", {"kill_on_close": True, "job_memory_mb": 256}),
    ("both_memory", {"kill_on_close": True, "process_memory_mb": 256, "job_memory_mb": 256}),
    ("full_256mb", {"kill_on_close": True, "process_memory_mb": 256, "job_memory_mb": 256,
                    "active_process": 1, "job_seconds": 60}),
    ("full_1gb", {"kill_on_close": True, "process_memory_mb": 1024, "job_memory_mb": 1024,
                  "active_process": 1, "job_seconds": 60}),
    ("job_time_only", {"kill_on_close": True, "job_seconds": 1}),
    ("active_process_2", {"kill_on_close": True, "active_process": 2}),
    # Is the memory ceiling ENFORCED, or only registered?
    ("overcommit_1gb", {"kill_on_close": True, "process_memory_mb": 1024,
                        "job_memory_mb": 1024, "allocate_mb": 1536}),
    ("undercommit_1gb", {"kill_on_close": True, "process_memory_mb": 1024,
                         "job_memory_mb": 1024, "allocate_mb": 128}),
    # Does the job's time limit actually end a process that is still working?
    ("overrun_1s", {"kill_on_close": True, "job_seconds": 1, "burn_ms": 8000}),
    ("under_1s", {"kill_on_close": True, "job_seconds": 60, "burn_ms": 500}),
    # Does an orphan survive the job handle closing, when it was told to sleep?
    ("orphan_after_close", {"kill_on_close": True, "child_outliving_parent": True,
                            "survivor_sleep_s": 20, "close_handle_after_spawn": True}),
]


def build_limits(case: dict) -> EXTENDED_LIMIT:
    info = EXTENDED_LIMIT()
    flags = JOB_OBJECT_LIMIT_BREAKAWAY_OK  # see module docstring
    if case.get("kill_on_close"):
        flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if case.get("active_process"):
        flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        info.BasicLimitInformation.ActiveProcessLimit = case["active_process"]
    if case.get("process_memory_mb"):
        flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY
        info.ProcessMemoryLimit = case["process_memory_mb"] * 1024 * 1024
    if case.get("job_memory_mb"):
        flags |= JOB_OBJECT_LIMIT_JOB_MEMORY
        info.JobMemoryLimit = case["job_memory_mb"] * 1024 * 1024
    if case.get("process_seconds"):
        flags |= JOB_OBJECT_LIMIT_PROCESS_TIME
        info.BasicLimitInformation.PerProcessUserTimeLimit = case["process_seconds"] * SECONDS
    if case.get("job_seconds"):
        flags |= JOB_OBJECT_LIMIT_JOB_TIME
        info.BasicLimitInformation.PerJobUserTimeLimit = case["job_seconds"] * SECONDS
    info.BasicLimitInformation.LimitFlags = flags
    return info


def inside_job(case_name: str, case: dict) -> dict:
    """Runs in the child. Creates a job, joins it, then spawns grandchildren."""
    close_after = case.get("close_handle_after_spawn", False)
    info = build_limits(case)
    job = KERNEL32.CreateJobObjectW(None, None)
    out: dict = {"case": case_name, "job_created": bool(job)}
    if not job:
        out["err"] = f"CreateJobObjectW failed: {ctypes.get_last_error()}"
        return out

    ok = KERNEL32.SetInformationJobObject(
        job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ctypes.byref(info), ctypes.sizeof(info))
    out["set_info"] = bool(ok)
    if not ok:
        out["err"] = f"SetInformationJobObject failed: {ctypes.get_last_error()}"
        return out

    already = w.BOOL()
    KERNEL32.IsProcessInJob(KERNEL32.GetCurrentProcess(), None, ctypes.byref(already))
    out["already_in_a_job"] = bool(already.value)

    assigned = KERNEL32.AssignProcessToJobObject(job, KERNEL32.GetCurrentProcess())
    out["assigned_self"] = bool(assigned)
    if not assigned:
        out["err"] = f"AssignProcessToJobObject failed: {ctypes.get_last_error()}"
        return out

    code = "import sys; print('grandchild-ok')"
    try:
        p1 = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE)
        o1, e1 = p1.communicate(timeout=20)
        out["grandchild_1"] = {"exit": p1.returncode, "out": o1.decode(errors="replace").strip(),
                               "err": e1.decode(errors="replace").strip()[:200]}
    except OSError as exc:
        out["grandchild_1"] = {"refused": str(exc)}
    except subprocess.TimeoutExpired:
        p1.kill()
        out["grandchild_1"] = {"timeout": True}

    if case.get("active_process"):
        try:
            p2 = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE)
            o2, e2 = p2.communicate(timeout=20)
            out["grandchild_2"] = {"exit": p2.returncode, "out": o2.decode(errors="replace").strip(),
                                   "err": e2.decode(errors="replace").strip()[:200]}
        except OSError as exc:
            out["grandchild_2"] = {"refused": str(exc)}
        except subprocess.TimeoutExpired:
            p2.kill()
            out["grandchild_2"] = {"timeout": True}

    # Memory: does the job kill a process that COMMITS past its ceiling? A quota
    # error at spawn time is evidence the limit is registered; only a death by
    # job shows it is enforced.
    if case.get("allocate_mb"):
        mb = case["allocate_mb"]
        try:
            blob = ctypes.create_string_buffer(mb * 1024 * 1024)
            for offset in range(0, mb * 1024 * 1024, 4096):
                blob[offset] = b"x"
            out["allocate"] = {"mb": mb, "survived": True, "readback": blob[0:1].decode()}
        except MemoryError as exc:
            out["allocate"] = {"mb": mb, "survived": False, "error": f"MemoryError {exc}"}

    # Wall clock: does JOB_OBJECT_LIMIT_JOB_TIME end the job's processes?
    if case.get("burn_ms"):
        deadline = time.time() + case["burn_ms"] / 1000.0
        ticks = 0
        while time.time() < deadline:
            ticks += 1
        out["burn"] = {"ms": case["burn_ms"], "ticks": ticks, "finished": True}

    # Does a grandchild outlive the parent when the job handle is closed?
    if case.get("child_outliving_parent"):
        proc = subprocess.Popen(
            [sys.executable, "-c",
             "import time,sys; time.sleep(float(sys.argv[1])); print('survivor-awake')",
             str(case.get("survivor_sleep_s", 5))],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out["survivor"] = {"pid": proc.pid, "started": True}

    if close_after:
        out["handle_closed"] = bool(KERNEL32.CloseHandle(job))
    else:
        out["handle_closed"] = False
    print(json.dumps(out))
    return out


def run_case(name: str, case: dict, outer_timeout: float = 45.0) -> dict:
    payload = dict(case)
    started = time.time()
    try:
        proc = subprocess.run(
            [sys.executable, __file__, "--inside", name, json.dumps(payload)],
            capture_output=True, text=True, timeout=outer_timeout)
        wall = time.time() - started
        line = [ln for ln in proc.stdout.splitlines() if ln.startswith("{")]
        detail = json.loads(line[-1]) if line else {"parse_error": proc.stdout[-300:]}
        killed_by_job = proc.returncode not in (0,)
        return {"case": name, "wall_s": round(wall, 2), "child_exit": proc.returncode,
                "job_killed_it": killed_by_job, "detail": detail,
                "stderr_tail": proc.stderr.strip()[-200:] if proc.stderr else ""}
    except subprocess.TimeoutExpired:
        return {"case": name, "wall_s": round(time.time() - started, 2), "child_exit": None,
                "timeout": True}


def main() -> int:
    if len(sys.argv) >= 2 and sys.argv[1] == "--inside":
        inside_job(sys.argv[2], json.loads(sys.argv[3]))
        return 0

    print(f"python {sys.version.split()[0]}  ({sys.executable})")
    print(f"this process already inside a job: {_in_job()}")
    print()
    results = []
    for name, case in CASES:
        r = run_case(name, case)
        results.append(r)
        detail = r.get("detail", {})
        alloc = detail.get("allocate")
        burn = detail.get("burn")
        extra = ""
        if isinstance(alloc, dict):
            extra += f" alloc={alloc.get('mb')}MB survived={alloc.get('survived')}"
        if isinstance(burn, dict):
            extra += f" burn={burn.get('ms')}ms finished={burn.get('finished')}"
        print(f"{name:20} child_exit={r.get('child_exit')!s:>5} wall={r.get('wall_s'):>5}s "
              f"assigned={detail.get('assigned_self')} "
              f"gc1={_summ(detail.get('grandchild_1'))} gc2={_summ(detail.get('grandchild_2'))}{extra}")
        if detail.get("err"):
            print(f"{'':18} err: {detail['err']}")
        if r.get("timeout"):
            print(f"{'':18} TIMED OUT - the job did not finish on its own")
    print()
    print(json.dumps(results, indent=2))
    return 0


def _summ(v) -> str:
    if not isinstance(v, dict):
        return "-"
    if "refused" in v:
        return f"REFUSED({v['refused'][:60]})"
    if v.get("timeout"):
        return "TIMEOUT"
    return f"exit{v.get('exit')}:{v.get('out', '')[:20] or v.get('err', '')[:30]}"


def _in_job() -> bool:
    b = w.BOOL()
    KERNEL32.IsProcessInJob(KERNEL32.GetCurrentProcess(), None, ctypes.byref(b))
    return bool(b.value)


if __name__ == "__main__":
    raise SystemExit(main())
