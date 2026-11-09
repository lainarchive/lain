"""Does the handle plumbing in this probe work at all, and what does the container see?

Two questions, both diagnostic rather than architectural:

  1. Can CreateProcessW here hand a child a real stdout file? `cmd.exe /c echo`
     answers it: if the marker reaches the file, the plumbing is sound and an
     empty child output means the child never wrote anything.
  2. What does an AppContainer actually experience at startup? A `cmd.exe` running
     `dir` and `whoami` inside the container reports whether it starts, what it can
     list, and which identity it holds -- which distinguishes "the container
     refuses the interpreter" from "the container never ran the command".
"""
import ctypes
import ctypes.wintypes as w
import json
import os
import tempfile

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
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


k32.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
k32.CreateFileW.restype = w.HANDLE
userenv.DeriveAppContainerSidFromAppContainerName.argtypes = [w.LPCWSTR, ctypes.POINTER(w.LPVOID)]
userenv.DeriveAppContainerSidFromAppContainerName.restype = w.HRESULT
k32.InitializeProcThreadAttributeList.argtypes = [w.LPVOID, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)]
k32.UpdateProcThreadAttribute.argtypes = [w.LPVOID, w.DWORD, ctypes.c_size_t, w.LPVOID,
                                          ctypes.c_size_t, w.LPVOID, ctypes.POINTER(ctypes.c_size_t)]
k32.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, w.LPVOID, w.LPVOID, w.BOOL, w.DWORD,
                               w.LPVOID, w.LPCWSTR, w.LPVOID, ctypes.POINTER(PROCESS_INFORMATION)]
k32.CreateProcessW.restype = w.BOOL


def run(command, workdir, sid=None, timeout_ms=30_000):
    out_path = os.path.join(workdir, f"out-{os.urandom(4).hex()}.txt")
    handle = k32.CreateFileW(out_path, 0x40000000, 0x00000001 | 0x00000002, None, 2, 0x80, None)
    if handle == INVALID_HANDLE_VALUE:
        return {"started": False, "stage": "out_file", "winerror": ctypes.get_last_error()}
    buf = ctypes.create_string_buffer(112)
    ctypes.cast(buf, ctypes.POINTER(w.DWORD))[0] = 112
    ctypes.cast(ctypes.byref(buf, 60), ctypes.POINTER(w.DWORD))[0] = 0x00000100
    ctypes.cast(ctypes.byref(buf, 80), ctypes.POINTER(w.HANDLE))[0] = INVALID_HANDLE_VALUE
    ctypes.cast(ctypes.byref(buf, 88), ctypes.POINTER(w.HANDLE))[0] = handle
    ctypes.cast(ctypes.byref(buf, 96), ctypes.POINTER(w.HANDLE))[0] = handle
    flags = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
    attr = None
    if sid is not None:
        sec = SECURITY_CAPABILITIES()
        sec.AppContainerSid = sid
        sec.Capabilities = None
        sec.CapabilityCount = 0
        sec.Reserved = 0
        size = ctypes.c_size_t(0)
        k32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        attr = ctypes.create_string_buffer(size.value)
        if not k32.InitializeProcThreadAttributeList(attr, 1, 0, ctypes.byref(size)):
            k32.CloseHandle(handle)
            return {"started": False, "stage": "attr_init", "winerror": ctypes.get_last_error()}
        if not k32.UpdateProcThreadAttribute(attr, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                            ctypes.byref(sec), ctypes.sizeof(sec), None, None):
            k32.CloseHandle(handle)
            return {"started": False, "stage": "attr_update", "winerror": ctypes.get_last_error()}
        ctypes.cast(ctypes.byref(buf, 104), ctypes.POINTER(w.LPVOID))[0] = ctypes.cast(attr, w.LPVOID)
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
    with open(out_path, "r", encoding="utf-8", errors="replace") as fh:
        return {"started": True, "exit_code": code.value,
                "exit_hex": f"0x{code.value & 0xFFFFFFFF:08X}", "output": fh.read().strip()}


def main():
    root = tempfile.mkdtemp(prefix="lain-diag-")
    report = {"root": root}
    cmd = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "cmd.exe")
    report["cmd"] = cmd

    # 1. The plumbing, with no container involved.
    report["plumbing_control"] = run(f'"{cmd}" /c echo PLUMBING-OK', root)

    # 2. The container, doing something that cannot fail for a runtime reason.
    sid = w.LPVOID()
    hr = userenv.DeriveAppContainerSidFromAppContainerName(PROFILE_NAME, ctypes.byref(sid))
    if hr != 0:
        report["derive"] = f"0x{hr & 0xFFFFFFFF:08X}"
        print(json.dumps(report, indent=2))
        return
    report["container_cmd"] = run(f'"{cmd}" /c "echo CONTAINER-OK & whoami & cd"', root, sid=sid)
    report["container_write_here"] = run(f'"{cmd}" /c "echo WRITTEN> {os.path.join(root, "c.txt")} & dir /b"', root, sid=sid)
    report["container_read_temp"] = run(f'"{cmd}" /c "type {os.path.join(root, "c.txt")}"', root, sid=sid)
    report["container_list_profile"] = run(
        f'"{cmd}" /c "dir /b {os.environ.get("USERPROFILE", "C:\\")}"', root, sid=sid)
    node = r"C:\Program Files\nodejs\node.exe"
    report["container_node_version"] = run(f'"{node}" --version', root, sid=sid)
    report["container_node_programfiles"] = run(
        f'"{cmd}" /c "dir /b \\"C:\\Program Files\\nodejs\\" | findstr /i node.exe"', root, sid=sid)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
