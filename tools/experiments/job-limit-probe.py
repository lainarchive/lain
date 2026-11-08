"""Refine the job-object measurements that V-2's design depends on.

`job-object-probe.py` measured that a memory ceiling *is* enforced, by watching
`create_string_buffer` raise `MemoryError`. That is evidence the allocation
failed. It is NOT evidence about which exit code the tool process carries out of
the job, and V-2's `status` contract is written to derive `killed_by_job` from
exit `0xC0000044` *or* a limit notification read back from the job. So the
questions left open, and measured here, are:

  Q1  When a tool commits past `JOB_OBJECT_LIMIT_PROCESS_MEMORY`, does the job
      KILL it (a trap-style exit code) or does the allocation merely fail
      (`MemoryError`, exit 1)? The two need different reporting.
  Q2  Does a completion port on the job deliver `JOB_OBJECT_MSG_*` notifications
      for the limits V-2 sets? This is the "read back from the job" arm of the
      contract, and it is the only way to name *which* ceiling fired.
  Q3  `JOB_OBJECT_LIMIT_JOB_TIME` is per-job *user-mode* time. Does it therefore
      fail to stop a tool that sleeps rather than computes? (If so, the ceiling
      table must say so instead of implying a wall-clock timeout.)
  Q4  Can the applied flags be read back with `QueryInformationJobObject`, so
      `limits_applied` is derived from the kernel rather than from a BOOL?
  Q5  If the supervisor is killed, is the tree it was watching reaped by
      `KILL_ON_JOB_CLOSE`? Checked against the OS, by pid.

Run:  python tools/experiments/job-limit-probe.py
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as w
import json
import os
import subprocess
import sys
import time

K = ctypes.WinDLL("kernel32", use_last_error=True)

K.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
K.CreateJobObjectW.restype = w.HANDLE
K.GetCurrentProcess.argtypes = []
K.GetCurrentProcess.restype = w.HANDLE
K.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
K.AssignProcessToJobObject.restype = w.BOOL
K.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
K.SetInformationJobObject.restype = w.BOOL
K.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD,
                                        ctypes.POINTER(w.DWORD)]
K.QueryInformationJobObject.restype = w.BOOL
K.CloseHandle.argtypes = [w.HANDLE]
K.CloseHandle.restype = w.BOOL
K.CreateIoCompletionPort.argtypes = [w.HANDLE, w.HANDLE, ctypes.c_size_t, w.DWORD]
K.CreateIoCompletionPort.restype = w.HANDLE
K.GetQueuedCompletionStatus.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD),
                                        ctypes.POINTER(ctypes.c_size_t),
                                        ctypes.POINTER(ctypes.c_void_p), w.DWORD]
K.GetQueuedCompletionStatus.restype = w.BOOL
K.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
K.OpenProcess.restype = w.HANDLE
K.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
K.WaitForSingleObject.restype = w.DWORD

NT = ctypes.WinDLL("ntdll")
NT.NtResumeProcess.argtypes = [w.HANDLE]
NT.NtResumeProcess.restype = ctypes.c_long

CREATE_SUSPENDED = 0x00000004
PROCESS_TERMINATE = 0x0001
PROCESS_SET_QUOTA = 0x0100
# 0x0800 is load-bearing: without it NtResumeProcess returns 0xC0000022
# STATUS_ACCESS_DENIED and the suspended child stays hung forever.
PROCESS_SUSPEND_RESUME = 0x0800

SYNCHRONIZE = 0x00100000
WAIT_TIMEOUT = 258
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

JOB_OBJECT_LIMIT_PROCESS_TIME = 0x00000002
JOB_OBJECT_LIMIT_JOB_TIME = 0x00000004
JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008
JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000

JobObjectBasicLimitInformation = 2
JobObjectAssociateCompletionPortInformation = 7
JobObjectExtendedLimitInformation = 9

SECONDS = 10_000_000

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


def limit_flags(spec: dict) -> int:
    flags = JOB_OBJECT_LIMIT_BREAKAWAY_OK
    if spec.get("kill_on_close"):
        flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if spec.get("process_memory_bytes"):
        flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY
    if spec.get("job_memory_bytes"):
        flags |= JOB_OBJECT_LIMIT_JOB_MEMORY
    if spec.get("job_ms"):
        flags |= JOB_OBJECT_LIMIT_JOB_TIME
    if spec.get("process_ms"):
        flags |= JOB_OBJECT_LIMIT_PROCESS_TIME
    return flags


def build_extended(spec: dict) -> EXTENDED_LIMIT:
    info = EXTENDED_LIMIT()
    info.BasicLimitInformation.PerJobUserTimeLimit = int(spec.get("job_ms", 0)) * 10_000
    info.BasicLimitInformation.PerProcessUserTimeLimit = int(spec.get("process_ms", 0)) * 10_000
    info.ProcessMemoryLimit = int(spec.get("process_memory_bytes", 0))
    info.JobMemoryLimit = int(spec.get("job_memory_bytes", 0))
    info.BasicLimitInformation.LimitFlags = limit_flags(spec)
    return info


def read_back(job) -> dict:
    """Q4: what the kernel says is set, rather than what a BOOL claimed."""
    info = EXTENDED_LIMIT()
    returned = w.DWORD(0)
    ok = K.QueryInformationJobObject(job, JobObjectExtendedLimitInformation,
                                     ctypes.byref(info), ctypes.sizeof(info),
                                     ctypes.byref(returned))
    if not ok:
        return {"query_ok": False, "err": ctypes.get_last_error()}
    flags = info.BasicLimitInformation.LimitFlags
    return {
        "query_ok": True,
        "limit_flags": flags,
        "job_time": bool(flags & JOB_OBJECT_LIMIT_JOB_TIME),
        "process_memory": bool(flags & JOB_OBJECT_LIMIT_PROCESS_MEMORY),
        "kill_on_close": bool(flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE),
        "breakaway_ok": bool(flags & JOB_OBJECT_LIMIT_BREAKAWAY_OK),
        "per_job_user_time_limit_ticks": info.BasicLimitInformation.PerJobUserTimeLimit,
        "process_memory_limit": info.ProcessMemoryLimit,
    }


def drain_port(port, budget_s: float = 0.5) -> list:
    """Q2: every queued notification, until the port goes quiet."""
    out = []
    deadline = time.time() + budget_s
    while time.time() < deadline:
        code = w.DWORD(0)
        key = ctypes.c_size_t(0)
        ov = ctypes.c_void_p(None)
        ok = K.GetQueuedCompletionStatus(port, ctypes.byref(code), ctypes.byref(key),
                                         ctypes.byref(ov), 100)
        if not ok:
            if ctypes.get_last_error() == 258:
                continue
            break
        out.append({"msg": int(code.value), "name": MSG_NAMES.get(int(code.value), "?"),
                    "pid": int(key.value)})
    return out


def pid_alive(pid: int) -> bool:
    """Q5: ask the OS, never our own bookkeeping."""
    handle = K.OpenProcess(SYNCHRONIZE, False, pid)
    if not handle:
        return False
    try:
        return K.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
    finally:
        K.CloseHandle(handle)


def supervise(spec: dict, result_path: str) -> dict:
    """The supervisor shape job_host.py will take: assign SELF, then spawn."""
    out: dict = {"case": spec.get("case"), "supervisor_pid": None}
    job = K.CreateJobObjectW(None, None)
    if not job:
        out["fatal"] = f"CreateJobObjectW: {ctypes.get_last_error()}"
        return out

    port = K.CreateIoCompletionPort(INVALID_HANDLE_VALUE, None, 0, 0)
    if port:
        assoc = ASSOCIATE_COMPLETION_PORT()
        assoc.CompletionKey = ctypes.c_void_p(0)
        assoc.CompletionPort = port
        out["port_associated"] = bool(K.SetInformationJobObject(
            job, JobObjectAssociateCompletionPortInformation,
            ctypes.byref(assoc), ctypes.sizeof(assoc)))
    else:
        out["port_associated"] = False

    info = build_extended(spec)
    set_ok = K.SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                       ctypes.byref(info), ctypes.sizeof(info))
    out["set_info_ok"] = bool(set_ok)
    out["set_info_err"] = None if set_ok else ctypes.get_last_error()
    out["readback"] = read_back(job)

    # Q6: does the supervisor have to be IN the job? If it is, the job's own
    # time limit terminates the supervisor at the same instant as the tool, and
    # nothing gets reported. The alternative is to assign the tool instead,
    # which keeps KILL_ON_JOB_CLOSE (the handle still governs the tree) while
    # leaving the reporter alive to say what happened.
    assign = spec.get("assign", "self")
    me = K.GetCurrentProcess()
    if assign == "self":
        assigned = K.AssignProcessToJobObject(job, me)
        out["assigned"] = "self"
        out["assign_err"] = None if assigned else ctypes.get_last_error()
        if not assigned:
            return out

    if assign == "child_suspended":
        # The child is created suspended, so it cannot spawn anything at all
        # until it is already inside the job. This is what removes the escape
        # window that assigning after a normal start would leave open, while
        # keeping the supervisor out of the job so it survives to report.
        child = subprocess.Popen([sys.executable, "-c", spec["child_code"]],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 creationflags=CREATE_SUSPENDED)
        hand = K.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SUSPEND_RESUME,
                             False, child.pid)
        out["opened_child"] = bool(hand)
        assigned = K.AssignProcessToJobObject(job, hand)
        out["assigned"] = "child_suspended"
        out["assign_err"] = None if assigned else ctypes.get_last_error()
        out["resume_status"] = int(NT.NtResumeProcess(hand))
        K.CloseHandle(hand)
    else:
        child = subprocess.Popen([sys.executable, "-c", spec["child_code"]],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if assign == "child":
            assigned = K.AssignProcessToJobObject(job, w.HANDLE(int(child._handle)))
            out["assigned"] = "child"
            out["assign_err"] = None if assigned else ctypes.get_last_error()
    out["child_pid"] = child.pid
    out["supervisor_pid"] = os.getpid()
    # Published before the long wait, so a driver that kills us can still find
    # the grandchild it is about to look for.
    with open(result_path + ".started", "w", encoding="utf-8") as fh:
        json.dump({"supervisor_pid": out["supervisor_pid"], "child_pid": child.pid}, fh)

    started = time.time()
    stdout, stderr = child.communicate()
    out["wall_s"] = round(time.time() - started, 2)
    out["child_exit"] = child.returncode
    out["child_exit_hex"] = hex(child.returncode & 0xFFFFFFFF)
    out["stdout"] = stdout.decode(errors="replace")[-300:]
    out["stderr"] = stderr.decode(errors="replace")[-300:]
    out["notifications"] = drain_port(port, 0.6) if port else []
    out["child_alive_after"] = pid_alive(child.pid)
    out["supervisor_alive_after"] = True  # reached only if we were not killed
    # The job handle is deliberately NOT closed here. The supervisor is inside
    # its own job, so closing a KILL_ON_JOB_CLOSE handle terminates the
    # supervisor mid-statement — the first version of this probe did exactly
    # that and printed nothing, with exit code 0. The result is written to disk
    # first and the handle closes when the process exits.
    return out


def driver() -> int:
    cases = [
        # Q1 + Q2: over the ceiling (uncaught) against under it (the control).
        ("mem_over", {"kill_on_close": True, "process_memory_bytes": 256 * 1024 * 1024,
                      "child_code": OVER}),
        ("mem_under", {"kill_on_close": True, "process_memory_bytes": 256 * 1024 * 1024,
                       "child_code": UNDER}),
        # Q3: burn vs sleep under the SAME one-second job-time ceiling.
        ("time_burn", {"kill_on_close": True, "job_ms": 1000, "child_code": BURN}),
        ("time_sleep", {"kill_on_close": True, "job_ms": 1000, "child_code": SLEEP}),
        # Q6: the same burn, with the supervisor OUTSIDE the job. If the
        # supervisor survives this one, it is the only shape that can report.
        ("time_burn_out", {"kill_on_close": True, "job_ms": 1000, "child_code": BURN,
                           "assign": "child"}),
        ("time_sleep_out", {"kill_on_close": True, "job_ms": 1000, "child_code": SLEEP,
                            "assign": "child"}),
        # Q7: a PER-PROCESS user-time limit, with the supervisor still inside the
        # job. If only the offender is terminated, the specified supervisor shape
        # survives and can still report — which the job-wide limit cannot do.
        ("proc_burn_in", {"kill_on_close": True, "process_ms": 1000, "child_code": BURN}),
        ("proc_sleep_in", {"kill_on_close": True, "process_ms": 1000, "child_code": SLEEP}),
        # Q8: the candidate final shape — supervisor outside the job, child
        # created suspended and assigned before it can run.
        ("time_burn_susp", {"kill_on_close": True, "job_ms": 1000, "child_code": BURN,
                            "assign": "child_suspended"}),
        ("mem_over_susp", {"kill_on_close": True, "process_memory_bytes": 256 * 1024 * 1024,
                           "child_code": OVER, "assign": "child_suspended"}),
    ]
    print(f"python {sys.version.split()[0]}  node-free probe")
    print()
    results = []
    for name, spec in cases:
        spec = dict(spec, case=name)
        started = time.time()
        # The raw per-case dump is scratch: it carries a Python traceback and host
        # paths, and it is rewritten on every run. Keeping it out of the repo means
        # tools/check/format.mjs (max 200 chars/line) only ever governs files a
        # human wrote. The durable record is this script plus the printed summary.
        scratch = os.path.join(os.environ.get("TEMP", os.getcwd()), f"lain-probe-{name}.json")
        proc = subprocess.run([sys.executable, __file__, "--supervise", json.dumps(spec),
                               scratch], capture_output=True, text=True, timeout=120)
        lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("{")]
        detail = json.loads(lines[-1]) if lines else {"parse_error": proc.stdout[-300:]}
        detail["driver_wall_s"] = round(time.time() - started, 2)
        results.append(detail)
        notes = ",".join(n["name"] for n in detail.get("notifications", []))
        print(f"{name:15} exit={detail.get('child_exit_hex')} wall={detail.get('wall_s')}s "
              f"sup_alive={detail.get('supervisor_alive_after')} "
              f"assigned={detail.get('assigned')} "
              f"rb(mem={detail.get('readback', {}).get('process_memory')},"
              f"time={detail.get('readback', {}).get('job_time')}) notes=[{notes}]")
        tail = (detail.get("stderr") or "").strip().splitlines()
        if tail:
            print(f"{'':12} stderr_tail: {tail[-1][:110]}")

    # Q5: kill the supervisor, then ask the OS whether the tree is gone.
    # Both shapes, because "the supervisor holds the handle" and "the supervisor
    # is in the job" are different reasons the tree might be reaped.
    for shape in ("self", "child"):
        result_path = __file__ + f".kill-{shape}.json"
        started_file = result_path + ".started"
        try:
            os.remove(started_file)  # a stale file from an earlier run would be
        except OSError:              # read as this run's pids — it was, once
            pass
        spec = {"case": f"kill_supervisor_{shape}", "kill_on_close": True,
                "child_code": LINGER, "assign": shape}
        sup = subprocess.Popen([sys.executable, __file__, "--supervise", json.dumps(spec), result_path],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        pids = None
        for _ in range(100):
            try:
                with open(started_file, encoding="utf-8") as fh:
                    pids = json.load(fh)
                break
            except (OSError, ValueError):
                time.sleep(0.1)
        killed = {"case": f"kill_supervisor_{shape}", "started": pids is not None}
        if pids:
            killed["child_alive_before_kill"] = pid_alive(pids["child_pid"])
            sup.kill()
            sup.wait(timeout=20)
            time.sleep(1.5)
            killed["supervisor_alive_after"] = pid_alive(pids["supervisor_pid"])
            killed["child_alive_after"] = pid_alive(pids["child_pid"])
            print(f"{'kill_' + shape:15} before={killed['child_alive_before_kill']} "
                  f"supervisor_gone={not killed['supervisor_alive_after']} "
                  f"child_survived={killed['child_alive_after']}")
        results.append(killed)
    print()
    print(json.dumps(results, indent=2))
    return 0


OVER = (
    "import ctypes\n"
    "chunks=[]\n"
    "for i in range(64):\n"
    "    b=ctypes.create_string_buffer(16*1024*1024)\n"
    "    for off in range(0,16*1024*1024,4096): b[off]=b'x'\n"
    "    chunks.append(b)\n"
    "print('allocated',len(chunks)*16,'MiB')\n"
)
UNDER = (
    "import ctypes\n"
    "b=ctypes.create_string_buffer(128*1024*1024)\n"
    "for off in range(0,128*1024*1024,4096): b[off]=b'x'\n"
    "print('allocated 128 MiB ok')\n"
)
BURN = (
    "import time\n"
    "end=time.time()+8\n"
    "n=0\n"
    "while time.time()<end: n+=1\n"
    "print('burn finished',n)\n"
)
SLEEP = "import time\nprint('sleeping')\ntime.sleep(4)\nprint('slept')\n"
LINGER = "import time\nprint('lingering')\ntime.sleep(30)\n"


def main() -> int:
    if len(sys.argv) >= 4 and sys.argv[1] == "--supervise":
        spec = json.loads(sys.argv[2])
        out = supervise(spec, sys.argv[3])
        with open(sys.argv[3], "w", encoding="utf-8", newline="\n") as fh:
            # LF and a final newline, so a scratch dump stays readable even when
            # someone points it at a path inside the repo.
            json.dump(out, fh, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        print(json.dumps(out))
        return 0
    return driver()


if __name__ == "__main__":
    raise SystemExit(main())
