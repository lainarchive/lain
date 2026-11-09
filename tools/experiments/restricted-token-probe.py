"""Can a restricted token launch a process here, and what can that process read?

V-3 needs read isolation for the tool process. The cheapest mechanism that composes
with the existing supervisor is a restricted token, so this probe answers three
questions in order, each one a prerequisite for the next:

  1. Can this unelevated process create a restricted token and launch a child with
     it? CreateProcessAsUser normally wants SeIncreaseQuotaPrivilege, which this
     token does NOT hold; the documented exception is a token built by
     CreateRestrictedToken. Measured here rather than assumed.
  2. Does restricting the token to a single SID ("write-restricted" shape) still
     let the child start -- and can it still read a file that grants BUILTIN\\Users
     but not that SID?
  3. With DISABLE_MAX_PRIVILEGE and an empty restricted-SID list, what does the
     child see?

The 'nobody' case is the interesting one: it is the shape read isolation would
need if the workspace is later granted to a dedicated SID, but it also tells us
whether a process can run at all with no group access.

Absolute paths only for the interpreter. Python 3.15 at C:\\Python315\\python.exe
is the same interpreter tools/win32/job_host.py uses.
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

INVALID_HANDLE_VALUE = w.HANDLE(-1).value
TOKEN_DUPLICATE = 0x0002
TOKEN_QUERY = 0x0008
TOKEN_ASSIGN_PRIMARY = 0x0001
TOKEN_ADJUST_DEFAULT = 0x0080
TOKEN_ADJUST_SESSIONID = 0x0100
TOKEN_ALL_ACCESS = 0xF01FF
MAXIMUM_ALLOWED = 0x02000000

DISABLE_MAX_PRIVILEGE = 0x1
SANDBOX_INERT = 0x2
WRITE_RESTRICTED = 0x8

LOGON_WITH_PROFILE = 0x00000001
CREATE_SUSPENDED = 0x00000004
CREATE_NO_WINDOW = 0x08000000
CREATE_UNICODE_ENVIRONMENT = 0x00000400

SE_GROUP_ENABLED = 0x00000004
SE_GROUP_USE_FOR_DENY_ONLY = 0x00000010


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Sid", w.LPVOID), ("Attributes", w.DWORD)]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR),
        ("lpTitle", w.LPWSTR), ("dwX", w.DWORD), ("dwY", w.DWORD),
        ("dwXSize", w.DWORD), ("dwYSize", w.DWORD), ("dwXCountChars", w.DWORD),
        ("dwYCountChars", w.DWORD), ("dwFillAttribute", w.DWORD),
        ("dwFlags", w.DWORD), ("wShowWindow", w.WORD), ("cbReserved2", w.WORD),
        ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
        ("hStdInput", w.HANDLE), ("hStdOutput", w.HANDLE), ("hStdError", w.HANDLE),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE),
                ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


k32.GetCurrentProcess.restype = w.HANDLE
adv.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
adv.OpenProcessToken.restype = w.BOOL
adv.CreateRestrictedToken.argtypes = [
    w.HANDLE, w.DWORD, w.DWORD, ctypes.POINTER(SID_AND_ATTRIBUTES),
    w.DWORD, ctypes.POINTER(SID_AND_ATTRIBUTES), w.DWORD,
    ctypes.POINTER(SID_AND_ATTRIBUTES), ctypes.POINTER(w.HANDLE)]
adv.CreateRestrictedToken.restype = w.BOOL
adv.ConvertSidToStringSidW.argtypes = [w.LPVOID, ctypes.POINTER(w.LPWSTR)]
adv.ConvertSidToStringSidW.restype = w.BOOL
adv.CreateProcessAsUserW.argtypes = [
    w.HANDLE, w.LPCWSTR, w.LPWSTR, w.LPVOID, w.LPVOID, w.BOOL, w.DWORD,
    w.LPVOID, w.LPCWSTR, ctypes.POINTER(STARTUPINFOW),
    ctypes.POINTER(PROCESS_INFORMATION)]
adv.CreateProcessAsUserW.restype = w.BOOL
k32.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
k32.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
k32.CloseHandle.argtypes = [w.HANDLE]


def token_groups(token):
    """The group SIDs in a token, as strings, with their attributes."""
    size = w.DWORD(0)
    adv.GetTokenInformation(token, 2, None, 0, ctypes.byref(size))  # TokenGroups
    buf = ctypes.create_string_buffer(size.value)
    if not adv.GetTokenInformation(token, 2, buf, size.value, ctypes.byref(size)):
        return []
    count = ctypes.cast(buf, ctypes.POINTER(w.DWORD)).contents.value
    # TOKEN_GROUPS: DWORD count, then count SID_AND_ATTRIBUTES
    offset = ctypes.sizeof(w.DWORD)
    if ctypes.sizeof(w.LPVOID) == 8:
        offset = 8  # alignment on x64
    out = []
    for i in range(count):
        entry = SID_AND_ATTRIBUTES.from_buffer_copy(buf, offset + i * ctypes.sizeof(SID_AND_ATTRIBUTES))
        strsid = w.LPWSTR()
        if adv.ConvertSidToStringSidW(entry.Sid, ctypes.byref(strsid)):
            out.append({"sid": strsid.value, "attributes": entry.Attributes})
            k32.LocalFree(strsid)
    return out


def find_sid(token, groups, wanted):
    """A SID string for one of the well-known groups, by last component."""
    for g in groups:
        if g["sid"].endswith(wanted):
            return g["sid"]
    return None


def sid_from_string(text):
    """A SID as a structure, so it can go into a restricted-SID list."""
    adv.ConvertStringSidToSidW.argtypes = [w.LPCWSTR, ctypes.POINTER(w.LPVOID)]
    adv.ConvertStringSidToSidW.restype = w.BOOL
    out = w.LPVOID()
    if not adv.ConvertStringSidToSidW(text, ctypes.byref(out)):
        raise OSError(f"ConvertStringSidToSidW failed for {text}")
    return out


def launch_with_token(child_token, command, workdir, logon_flags=0):
    """Start a child holding `child_token`. stderr comes back through a pipe."""
    err_read, err_write = os.pipe()
    handles = k32.GetStdHandle(-11)  # STD_ERROR_HANDLE, inherited
    si = STARTUPINFOW()
    si.cb = ctypes.sizeof(STARTUPINFOW)
    si.dwFlags = 0x00000100  # STARTF_USESTDHANDLES
    si.hStdError = err_write
    si.hStdOutput = err_write
    si.hStdInput = INVALID_HANDLE_VALUE
    pi = PROCESS_INFORMATION()
    os.set_handle_inheritable(err_write, True)
    cmdline = ctypes.create_unicode_buffer(command)
    env = None
    ok = adv.CreateProcessAsUserW(
        child_token, None, cmdline, None, None, True,
        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
        env, workdir, ctypes.byref(si), ctypes.byref(pi))
    err = ctypes.get_last_error()
    os.close(err_write)
    if not ok:
        os.close(err_read)
        return {"started": False, "winerror": err,
                "message": ctypes.FormatError(err).strip()}
    k32.WaitForSingleObject(pi.hProcess, 30_000)
    code = w.DWORD()
    k32.GetExitCodeProcess(pi.hProcess, ctypes.byref(code))
    k32.CloseHandle(pi.hThread)
    k32.CloseHandle(pi.hProcess)
    chunks = []
    while True:
        data = os.read(err_read, 65536)
        if not data:
            break
        chunks.append(data)
    os.close(err_read)
    return {"started": True, "exit_code": code.value,
            "output": b"".join(chunks).decode("utf-8", "replace")}


def main():
    report = {"interpreter": sys.executable, "cwd": os.getcwd()}
    me = k32.GetCurrentProcess()
    token = w.HANDLE()
    if not adv.OpenProcessToken(me, TOKEN_DUPLICATE | TOKEN_QUERY, ctypes.byref(token)):
        report["fatal"] = f"OpenProcessToken failed: {ctypes.get_last_error()}"
        print(json.dumps(report, indent=2))
        return
    groups = token_groups(token)
    report["process_token_group_count"] = len(groups)
    report["process_token_groups"] = [g["sid"] for g in groups]
    users_sid = find_sid(token, groups, "-5-32-545")
    report["builtin_users_sid"] = users_sid

    # A sentinel directory whose ACL grants BUILTIN\Users but not a single
    # specific SID, plus one granted to that single SID. The difference between
    # the two is the whole question.
    root = tempfile.mkdtemp(prefix="lain-restok-")
    shared = os.path.join(root, "shared-by-users")
    personal = os.path.join(root, "personal-only")
    os.makedirs(shared)
    os.makedirs(personal)
    for d in (shared, personal):
        with open(os.path.join(d, "sentinel.txt"), "w", encoding="utf-8") as fh:
            fh.write("SENTINEL-" + os.urandom(6).hex())
    subprocess.run(["icacls", shared, "/grant", "*S-1-5-32-545:(OI)(CI)R"],
                   capture_output=True, text=True)
    subprocess.run(["icacls", personal, "/inheritance:r", "/grant", "*S-1-5-32-544:F"],
                   capture_output=True, text=True)
    report["sentinel_root"] = root

    child_script = (
        "import json,os,sys;"
        f"paths={[os.path.join(shared,'sentinel.txt'), os.path.join(personal,'sentinel.txt')]!r};"
        "out={};"
        "\nfor p in paths:\n"
        "    try:\n"
        "        out[p]=open(p,encoding='utf-8').read()\n"
        "    except OSError as e:\n"
        "        out[p]=f'{type(e).__name__}: {e.winerror}'\n"
        "print(json.dumps(out))"
    )
    script_path = os.path.join(root, "child.py")
    with open(script_path, "w", encoding="utf-8") as fh:
        fh.write(child_script)

    def run_case(name, flags, restricted_sids):
        entry = {"flags": flags, "restricting_sids": [s for s, _ in restricted_sids]}
        n_sids = len(restricted_sids)
        arr = (SID_AND_ATTRIBUTES * n_sids)() if n_sids else None
        for i, (_text, sid_ptr) in enumerate(restricted_sids):
            arr[i].Sid = sid_ptr
            arr[i].Attributes = 0
        restricted = w.HANDLE()
        ok = adv.CreateRestrictedToken(
            token, flags, 0, None, 0, None, n_sids, arr, ctypes.byref(restricted))
        if not ok:
            entry["token_error"] = ctypes.get_last_error()
            entry["token_message"] = ctypes.FormatError(entry["token_error"]).strip()
            report[name] = entry
            return
        cmd = f'"{sys.executable}" "{script_path}"'
        entry["child"] = launch_with_token(restricted, cmd, root)
        k32.CloseHandle(restricted)
        report[name] = entry

    run_case("case_restricted_users_only", WRITE_RESTRICTED,
             [("BUILTIN\\Users", sid_from_string(users_sid))])
    run_case("case_disable_max_privilege", DISABLE_MAX_PRIVILEGE, [])
    run_case("case_write_restricted_no_restricting_sids", WRITE_RESTRICTED, [])

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
