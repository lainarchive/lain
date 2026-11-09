"""Can an AppContainer hold the tool process, and can Node and Python run inside it?

The restricted-token route is closed on this machine: CreateProcessAsUser returns
winerror 5 for every token shape, because the account holds neither
SeIncreaseQuotaPrivilege nor SeImpersonatePrivilege and its token is already
filtered. AppContainer takes a different path -- CreateProcess with
PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, which needs neither privilege -- so
this measures how far that path actually goes here.

Stdout is redirected to a file rather than a pipe. The pipe version captured
nothing from a child that exited 0, which is indistinguishable from a child that
never ran; a file either has bytes in it or it does not.

Usage: appcontainer-probe.py [case ...]     (default: all cases)
  profile  create the profile, derive its SID
  start    can each interpreter start at all, and with which exit code
  reads    what the container can and cannot read, from a running Node
  python   why the Python child dies, using Node as the witness
"""
import ctypes
import ctypes.wintypes as w
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
adv = ctypes.WinDLL("advapi32", use_last_error=True)
userenv = ctypes.WinDLL("userenv", use_last_error=True)

PROFILE_NAME = "lain.v3.probe"
ERROR_ALREADY_EXISTS = 183
STATUS_DLL_NOT_FOUND = 0xC0000135

EXTENDED_STARTUPINFO_PRESENT = 0x00080000
CREATE_NO_WINDOW = 0x08000000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
CREATE_SUSPENDED = 0x00000004
PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009
STARTF_USESTDHANDLES = 0x00000100
INVALID_HANDLE_VALUE = w.HANDLE(-1).value
GENERIC_WRITE = 0x40000000
FILE_SHARE_READ = 0x00000001
CREATE_ALWAYS = 2
INFINITE = 0xFFFFFFFF

NODE = os.environ.get("LAIN_PROBE_NODE", r"C:\Program Files\nodejs\node.exe")
# Overridable so the same probe can measure an interpreter placed somewhere the
# container SID is explicitly granted, which is the remedy this has to prove.
PYTHON = os.environ.get("LAIN_PROBE_PYTHON", r"C:\Python315\python.exe")
USERPROFILE = os.path.expanduser("~")
SCRATCH = tempfile.gettempdir()


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


userenv.CreateAppContainerProfile.argtypes = [
    w.LPCWSTR, w.LPCWSTR, w.LPCWSTR, ctypes.POINTER(SID_AND_ATTRIBUTES), w.DWORD,
    ctypes.POINTER(w.LPVOID)]
userenv.CreateAppContainerProfile.restype = w.HRESULT
userenv.DeriveAppContainerSidFromAppContainerName.argtypes = [w.LPCWSTR, ctypes.POINTER(w.LPVOID)]
userenv.DeriveAppContainerSidFromAppContainerName.restype = w.HRESULT
userenv.DeleteAppContainerProfile.argtypes = [w.LPCWSTR]
userenv.DeleteAppContainerProfile.restype = w.HRESULT
adv.ConvertSidToStringSidW.argtypes = [w.LPVOID, ctypes.POINTER(w.LPWSTR)]
adv.ConvertSidToStringSidW.restype = w.BOOL
k32.InitializeProcThreadAttributeList.argtypes = [w.LPVOID, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)]
k32.UpdateProcThreadAttribute.argtypes = [
    w.LPVOID, w.DWORD, ctypes.c_size_t, w.LPVOID, ctypes.c_size_t, w.LPVOID, ctypes.POINTER(ctypes.c_size_t)]
k32.CreateProcessW.argtypes = [
    w.LPCWSTR, w.LPWSTR, w.LPVOID, w.LPVOID, w.BOOL, w.DWORD, w.LPVOID,
    w.LPCWSTR, w.LPVOID, ctypes.POINTER(PROCESS_INFORMATION)]
k32.CreateProcessW.restype = w.BOOL
k32.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
k32.CreateFileW.restype = w.HANDLE
k32.ResumeThread.argtypes = [w.HANDLE]
k32.ResumeThread.restype = w.DWORD


def hr_text(hr):
    """An HRESULT is negative in Python; render it the way Win32 documents it."""
    code = hr & 0xFFFFFFFF
    win32 = code & 0xFFFF if (code & 0xFFFF0000) == 0x80070000 else None
    out = {"hr": f"0x{code:08X}"}
    if win32 is not None:
        out["win32"] = win32
        out["win32_hex"] = f"0x{win32:04X}"
        out["message"] = ctypes.FormatError(win32).strip()
    else:
        signed = code - 0x100000000 if code >= 0x80000000 else code
        out["message"] = ctypes.FormatError(signed).strip()
    return out


def sid_text(sid):
    out = w.LPWSTR()
    if adv.ConvertSidToStringSidW(sid, ctypes.byref(out)):
        text = out.value
        k32.LocalFree(out)
        return text
    return None


def open_for_child(path):
    """A handle the child inherits. Opened by the parent, so the container's
    own ACL never enters into it -- the child writes through a handle that
    already carries the access."""
    handle = k32.CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, None, CREATE_ALWAYS, 0, None)
    if handle == INVALID_HANDLE_VALUE:
        raise OSError(ctypes.get_last_error(), "CreateFileW %s" % path)
    os.set_handle_inheritable(handle, True)
    return handle


def run_child(sid, command, cwd, out_path, capabilities=None, suspended=False, job=None, wait=True):
    caps = capabilities or []
    n = len(caps)
    cap_arr = (SID_AND_ATTRIBUTES * n)() if n else None
    for i, text in enumerate(caps):
        cap_arr[i].Sid = text
        cap_arr[i].Attributes = 0
    sec = SECURITY_CAPABILITIES()
    sec.AppContainerSid = sid
    sec.Capabilities = cap_arr
    sec.CapabilityCount = n
    sec.Reserved = 0

    size = ctypes.c_size_t(0)
    k32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
    buffer = ctypes.create_string_buffer(size.value)
    if not k32.InitializeProcThreadAttributeList(buffer, 1, 0, ctypes.byref(size)):
        return {"started": False, "stage": "attribute_init", "winerror": ctypes.get_last_error()}
    if not k32.UpdateProcThreadAttribute(
            buffer, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            ctypes.byref(sec), ctypes.sizeof(sec), None, None):
        return {"started": False, "stage": "attribute_update", "winerror": ctypes.get_last_error()}

    si = STARTUPINFOEXW()
    ctypes.memset(ctypes.byref(si), 0, ctypes.sizeof(si))
    # cb is the size of the whole STARTUPINFOEX when EXTENDED_STARTUPINFO_PRESENT
    # is passed: 104 is sizeof(STARTUPINFO) on x64, plus the attribute pointer.
    ctypes.cast(ctypes.byref(si), ctypes.POINTER(w.DWORD))[0] = ctypes.sizeof(si)
    si.lpAttributeList = ctypes.cast(buffer, w.LPVOID)

    handle = open_for_child(out_path)
    start = ctypes.cast(ctypes.byref(si), ctypes.POINTER(ctypes.c_byte))
    # The struct is opaque here, so the std handles are written at their x64
    # offsets directly: dwFlags 60, hStdInput 80, hStdOutput 88, hStdError 96.
    ctypes.cast(ctypes.byref(si, 60), ctypes.POINTER(w.DWORD))[0] = STARTF_USESTDHANDLES
    ctypes.cast(ctypes.byref(si, 80), ctypes.POINTER(w.HANDLE))[0] = INVALID_HANDLE_VALUE
    ctypes.cast(ctypes.byref(si, 88), ctypes.POINTER(w.HANDLE))[0] = handle
    ctypes.cast(ctypes.byref(si, 96), ctypes.POINTER(w.HANDLE))[0] = handle

    flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
    if suspended:
        flags |= CREATE_SUSPENDED
    pi = PROCESS_INFORMATION()
    cmdline = ctypes.create_unicode_buffer(command)
    ok = k32.CreateProcessW(None, cmdline, None, None, True, flags, None, cwd,
                            ctypes.byref(si), ctypes.byref(pi))
    err = ctypes.get_last_error()
    k32.CloseHandle(handle)
    if not ok:
        return {"started": False, "stage": "create_process", "winerror": err,
                "message": ctypes.FormatError(err).strip()}
    report = {"started": True, "pid": pi.dwProcessId}
    if suspended:
        # CreateProcessW hands back the thread handle, which Popen does not, so
        # the V-2 NtResumeProcess dance is unnecessary on this path.
        if job is not None:
            report["assign"] = bool(k32.AssignProcessToJobObject(job, pi.hProcess))
            report["assign_error"] = ctypes.get_last_error()
            inside = w.BOOL()
            k32.IsProcessInJob(pi.hProcess, None, ctypes.byref(inside))
            report["in_job"] = bool(inside.value)
        report["resume"] = k32.ResumeThread(pi.hThread)
        report["resume_error"] = ctypes.get_last_error()
    if not wait:
        k32.CloseHandle(pi.hThread)
        k32.CloseHandle(pi.hProcess)
        report["waited"] = False
        return report
    k32.WaitForSingleObject(pi.hProcess, 30_000)
    code = w.DWORD()
    k32.GetExitCodeProcess(pi.hProcess, ctypes.byref(code))
    report["exit_code"] = code.value
    if code.value == STATUS_DLL_NOT_FOUND:
        report["exit_name"] = "STATUS_DLL_NOT_FOUND"
    k32.CloseHandle(pi.hThread)
    k32.CloseHandle(pi.hProcess)
    with open(out_path, "r", encoding="utf-8", errors="replace") as fh:
        report["output"] = fh.read()[:2000]
    return report


def make_container():
    sid = w.LPVOID()
    hr = userenv.CreateAppContainerProfile(
        PROFILE_NAME, "Lain V-3 probe", "read-isolation feasibility", None, 0, ctypes.byref(sid))
    created = hr == 0
    info = {"created": created, "create": hr_text(hr) if not created else {"hr": "S_OK"}}
    if created:
        info["sid"] = sid_text(sid)
    else:
        derived = w.LPVOID()
        hr2 = userenv.DeriveAppContainerSidFromAppContainerName(PROFILE_NAME, ctypes.byref(derived))
        if hr2 != 0:
            info["derive"] = hr_text(hr2)
            return None, info
        sid = derived
        info["derived_sid"] = sid_text(sid)
    info["derived_after_create"] = sid_text(sid)
    return sid, info


def scratch(root, sid):
    granted = os.path.join(root, "granted")
    ungranted = os.path.join(root, "ungranted")
    os.makedirs(granted)
    os.makedirs(ungranted)
    with open(os.path.join(granted, "sentinel.txt"), "w", encoding="utf-8") as fh:
        fh.write("GRANTED-SENTINEL")
    with open(os.path.join(ungranted, "sentinel.txt"), "w", encoding="utf-8") as fh:
        fh.write("UNGRANTED-SENTINEL")
    text = sid_text(sid)
    # Modify, not read: the child has to be able to write its own result back.
    grant = subprocess.run(["icacls", granted, "/grant", f"*{text}:(OI)(CI)M"],
                           capture_output=True, text=True)
    return granted, ungranted, grant.returncode


def case_profile(_):
    sid, info = make_container()
    out = {"case": "profile", "container": info}
    if sid is not None:
        out["container"]["sid"] = sid_text(sid)
        k32.CloseHandle(w.HANDLE(0))
    return out


def case_start(root, sid, granted):
    cases = {}
    for label, exe, args in (
            ("node", NODE, "-e \"console.log('node alive ' + process.version)\""),
            ("python", PYTHON, "-c \"import sys; print('python alive', sys.version.split()[0])\"")):
        out_path = os.path.join(root, "out-%s.txt" % label)
        cases[label] = run_child(sid, '"%s" %s' % (exe, args), granted, out_path)
    return {"case": "start", "children": cases}


READ_JS = r"""
const fs = require('node:fs');
const paths = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const out = {};
for (const [name, p] of Object.entries(paths)) {
  try {
    if (fs.statSync(p).isDirectory()) {
      out[name] = { ok: true, kind: 'dir', entries: fs.readdirSync(p).length };
    } else {
      out[name] = { ok: true, kind: 'file', text: fs.readFileSync(p, 'utf8').slice(0, 40) };
    }
  } catch (e) {
    out[name] = { ok: false, code: e.code, errno: e.errno, message: e.message };
  }
}
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
console.log('wrote ' + process.argv[2]);
"""


def case_reads(root, sid, granted):
    targets = {
        "granted_sentinel": os.path.join(granted, "sentinel.txt"),
        "ungranted_sentinel": os.path.join(root, "ungranted", "sentinel.txt"),
        "python_install": os.path.dirname(PYTHON),
        # The exe loads and the sibling DLL does not, which is the whole of the
        # Python failure. Measure the two files, not the directory.
        "python_exe": PYTHON,
        "python_dll": os.path.join(os.path.dirname(PYTHON), "python315.dll"),
        "node_exe": NODE,
        "node_install": os.path.dirname(NODE),
        "userprofile": USERPROFILE,
        "userprofile_ssh": os.path.join(USERPROFILE, ".ssh"),
        "temp": SCRATCH,
        "windows": r"C:\Windows\win.ini",
    }
    inputs = os.path.join(granted, "targets.json")
    result = os.path.join(granted, "reads.json")
    with open(inputs, "w", encoding="utf-8") as fh:
        json.dump(targets, fh)
    out_path = os.path.join(root, "out-reads.txt")
    child = run_child(sid, '"%s" -e "%s" "%s" "%s"'
                      % (NODE, READ_JS.replace('"', '\\"').replace("\n", " "), inputs, result),
                      granted, out_path)
    report = {"case": "reads", "child": child, "targets": targets}
    try:
        with open(result, "r", encoding="utf-8") as fh:
            report["reads"] = json.load(fh)
    except OSError as exc:
        report["reads"] = None
        report["reads_error"] = str(exc)
    return report


def main():
    wanted = sys.argv[1:] or ["profile", "start", "reads"]
    root = tempfile.mkdtemp(prefix="lain-appc-")
    sid, info = make_container()
    report = {"root": root, "profile_name": PROFILE_NAME, "container": info,
              "interpreter": sys.executable, "node": NODE, "python": PYTHON}
    if sid is None:
        report["verdict"] = "no AppContainer SID; the path is closed"
        print(json.dumps(report, indent=2))
        return
    granted, _ungranted, rc = scratch(root, sid)
    report["grant_rc"] = rc
    report["granted"] = granted
    for name in wanted:
        if name == "profile":
            continue
        if name == "start":
            report["start"] = case_start(root, sid, granted)
        elif name == "reads":
            report["reads"] = case_reads(root, sid, granted)
    if info.get("created"):
        report["delete"] = hr_text(userenv.DeleteAppContainerProfile(PROFILE_NAME))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
