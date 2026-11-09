"""Does an AppContainer actually stop Node from reading the user profile?

The previous probe established the two facts that make this worth testing:
CreateAppContainerProfile cannot run unelevated (0x800700B7, ERROR_ALREADY_EXISTS
from the registry write), but DeriveAppContainerSidFromAppContainerName returns a
SID anyway -- the container exists by name, so no profile is needed to launch into
it. Node started under that SID (exit 0).

So the open question is no longer "does it launch" but "what can it read". This
probe asks exactly that, with a positive control in the same run, because a
boundary that denies everything is a failure rather than a success:

  A. an unrestricted Node reads every sentinel -- the control that proves the
     sentinels are readable at all;
  B. the same Node inside the AppContainer reads a sentinel granted to the
     AppContainer SID, and is refused the others;
  C. which error code a refusal produces, since EPERM and ENOENT mean different
     things to a caller that has to report honestly.

Sentinel paths come from three places a read boundary has to separate: a directory
explicitly granted to the container, a sibling directory that was not, and the
user profile itself (a file that does not exist, so a refusal is distinguishable
from a successful read -- the probe never opens a real credential file).
"""
import ctypes
import ctypes.wintypes as w
import json
import os
import subprocess
import sys
import tempfile

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
adv = ctypes.WinDLL("advapi32", use_last_error=True)
userenv = ctypes.WinDLL("userenv", use_last_error=True)

PROFILE_NAME = "lain.v3.probe"
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
CREATE_NO_WINDOW = 0x08000000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009
INVALID_HANDLE_VALUE = w.HANDLE(-1).value


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Sid", w.LPVOID), ("Attributes", w.DWORD)]


class SECURITY_CAPABILITIES(ctypes.Structure):
    _fields_ = [("AppContainerSid", w.LPVOID),
                ("Capabilities", ctypes.POINTER(SID_AND_ATTRIBUTES)),
                ("CapabilityCount", w.DWORD), ("Reserved", w.DWORD)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE),
                ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


userenv.DeriveAppContainerSidFromAppContainerName.argtypes = [w.LPCWSTR, ctypes.POINTER(w.LPVOID)]
userenv.DeriveAppContainerSidFromAppContainerName.restype = w.HRESULT
adv.ConvertSidToStringSidW.argtypes = [w.LPVOID, ctypes.POINTER(w.LPWSTR)]
adv.ConvertSidToStringSidW.restype = w.BOOL
k32.InitializeProcThreadAttributeList.argtypes = [w.LPVOID, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)]
k32.UpdateProcThreadAttribute.argtypes = [w.LPVOID, w.DWORD, ctypes.c_size_t, w.LPVOID,
                                          ctypes.c_size_t, w.LPVOID, ctypes.POINTER(ctypes.c_size_t)]
k32.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, w.LPVOID, w.LPVOID, w.BOOL, w.DWORD,
                               w.LPVOID, w.LPCWSTR, w.LPVOID, ctypes.POINTER(PROCESS_INFORMATION)]
k32.CreateProcessW.restype = w.BOOL


def sid_text(sid):
    out = w.LPWSTR()
    if adv.ConvertSidToStringSidW(sid, ctypes.byref(out)):
        text = out.value
        k32.LocalFree(out)
        return text
    return None


def run(command, workdir, sid=None, timeout_ms=60_000):
    """Run a command, optionally inside `sid`. Returns exit code and merged output.

    Output goes to a FILE rather than a pipe on purpose. An AppContainer has no
    access to the parent's pipe handles, so a piped child writes nothing and an
    empty `output` cannot be told apart from a child that never ran. Measured the
    hard way: the first version of this probe returned exit 0 with no output and
    looked like a successful but silent run.
    """
    out_path = os.path.join(workdir, f"child-out-{os.urandom(4).hex()}.txt")
    handle = k32.CreateFileW(out_path, 0x40000000, 0x00000001 | 0x00000002, None,
                             2, 0x80, None)  # GENERIC_WRITE, share R/W, CREATE_ALWAYS, NORMAL
    if handle == INVALID_HANDLE_VALUE:
        return {"started": False, "stage": "out_file", "winerror": ctypes.get_last_error()}
    # STARTUPINFOEXW is opaque in ctypes here, so the struct is built in a byte
    # buffer and the fields that matter are written at their x64 offsets:
    # cb 0, dwFlags 60, hStdInput 80, hStdOutput 88, hStdError 96, and the
    # attribute-list pointer immediately after the 104-byte STARTUPINFO.
    buf = ctypes.create_string_buffer(112)
    ctypes.cast(buf, ctypes.POINTER(w.DWORD))[0] = 104 + 8  # cb = sizeof(STARTUPINFOEXW)
    ctypes.cast(ctypes.byref(buf, 60), ctypes.POINTER(w.DWORD))[0] = 0x00000100  # STARTF_USESTDHANDLES
    ctypes.cast(ctypes.byref(buf, 80), ctypes.POINTER(w.HANDLE))[0] = INVALID_HANDLE_VALUE
    ctypes.cast(ctypes.byref(buf, 88), ctypes.POINTER(w.HANDLE))[0] = handle
    ctypes.cast(ctypes.byref(buf, 96), ctypes.POINTER(w.HANDLE))[0] = handle

    flags = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
    attr_buffer = None
    if sid is not None:
        sec = SECURITY_CAPABILITIES()
        sec.AppContainerSid = sid
        sec.Capabilities = None
        sec.CapabilityCount = 0
        sec.Reserved = 0
        size = ctypes.c_size_t(0)
        k32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        attr_buffer = ctypes.create_string_buffer(size.value)
        if not k32.InitializeProcThreadAttributeList(attr_buffer, 1, 0, ctypes.byref(size)):
            err = ctypes.get_last_error()
            k32.CloseHandle(handle)
            return {"started": False, "stage": "attribute_init", "winerror": err}
        if not k32.UpdateProcThreadAttribute(
                attr_buffer, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                ctypes.byref(sec), ctypes.sizeof(sec), None, None):
            err = ctypes.get_last_error()
            k32.CloseHandle(handle)
            return {"started": False, "stage": "attribute_update", "winerror": err}
        ctypes.cast(ctypes.byref(buf, 104), ctypes.POINTER(w.LPVOID))[0] = ctypes.cast(attr_buffer, w.LPVOID)
        flags |= EXTENDED_STARTUPINFO_PRESENT

    pi = PROCESS_INFORMATION()
    cmdline = ctypes.create_unicode_buffer(command)
    ok = k32.CreateProcessW(None, cmdline, None, None, True, flags, None, workdir,
                            ctypes.byref(buf), ctypes.byref(pi))
    err = ctypes.get_last_error()
    k32.CloseHandle(handle)
    if not ok:
        return {"started": False, "stage": "create_process", "winerror": err,
                "message": ctypes.FormatError(err).strip()}
    k32.WaitForSingleObject(pi.hProcess, timeout_ms)
    code = w.DWORD()
    k32.GetExitCodeProcess(pi.hProcess, ctypes.byref(code))
    k32.CloseHandle(pi.hThread)
    k32.CloseHandle(pi.hProcess)
    try:
        with open(out_path, "r", encoding="utf-8", errors="replace") as fh:
            output = fh.read().strip()
    except OSError as exc:
        output = f"<the parent could not read its own output file: {exc}>"
    return {"started": True, "exit_code": code.value,
            "exit_hex": f"0x{code.value & 0xFFFFFFFF:08X}",
            "output": output, "output_path": out_path}


def main():
    report = {}
    derived = w.LPVOID()
    hr = userenv.DeriveAppContainerSidFromAppContainerName(PROFILE_NAME, ctypes.byref(derived))
    if hr != 0:
        report["fatal"] = {"stage": "derive_sid", "hr": f"0x{hr & 0xFFFFFFFF:08X}"}
        print(json.dumps(report, indent=2))
        return
    sid_str = sid_text(derived)
    report["appcontainer_sid"] = sid_str

    root = tempfile.mkdtemp(prefix="lain-appc2-")
    granted = os.path.join(root, "granted")
    not_granted = os.path.join(root, "not-granted")
    os.makedirs(granted)
    os.makedirs(not_granted)
    for d, marker in ((granted, "GRANTED"), (not_granted, "NOTGRANTED")):
        with open(os.path.join(d, "sentinel.txt"), "w", encoding="utf-8") as fh:
            fh.write(marker + "-" + os.urandom(6).hex())
    # Grant the container read on exactly one of the two.
    subprocess.run(["icacls", granted, "/grant", f"*{sid_str}:(OI)(CI)R"], capture_output=True, text=True)
    # The profile path: a file that does not exist, so "refused" and "read" cannot
    # be confused. Never a real credential file.
    profile_probe = os.path.join(os.environ.get("USERPROFILE", root), ".lain-v3-probe-never-exists.txt")
    user_dir = os.path.dirname(profile_probe)

    node_exe = r"C:\Program Files\nodejs\node.exe"
    if not os.path.exists(node_exe):
        report["fatal"] = {"stage": "node", "message": f"no node at {node_exe}"}
        print(json.dumps(report, indent=2))
        return
    report["node"] = node_exe

    script = os.path.join(root, "read-probe.mjs")
    targets = [os.path.join(granted, "sentinel.txt"),
               os.path.join(not_granted, "sentinel.txt"),
               profile_probe,
               os.path.join(user_dir, "ntuser.dat")]
    with open(script, "w", encoding="utf-8") as fh:
        fh.write(
            "import { readFileSync, readdirSync } from 'node:fs';\n"
            f"const targets = {json.dumps(targets)};\n"
            "const out = {};\n"
            "for (const p of targets) {\n"
            "  try { out[p] = 'READ ' + readFileSync(p, 'utf8').slice(0, 24); }\n"
            "  catch (e) { out[p] = e.code + ' (errno ' + e.errno + ')'; }\n"
            "}\n"
            "try { out['listdir:' + " + json.dumps(user_dir) + "] = readdirSync(" + json.dumps(user_dir) + ").length + ' entries'; }\n"
            "catch (e) { out['listdir:' + " + json.dumps(user_dir) + "] = e.code + ' (errno ' + e.errno + ')'; }\n"
            "console.log(JSON.stringify(out, null, 2));\n")

    command = f'"{node_exe}" "{script}"'
    report["control_unrestricted_node"] = run(command, root)
    report["appcontainer_node"] = run(command, root, sid=derived)
    report["sentinel_root"] = root
    report["granted_dir"] = granted
    report["not_granted_dir"] = not_granted
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
