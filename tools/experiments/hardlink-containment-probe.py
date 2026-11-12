"""What an AppContainer can actually reach through a hard link, and why.

The previous matrix planted a hard link to an ungranted file inside a granted
workspace and reported `hardlink=EPERM/-4048`, then explained it with "a link and
its target share one security descriptor". A review pointed out that the second
claim is not evidence for the first, and it is right: the same reading would follow
from a per-name descriptor.

This probe separates the two questions with the API and then reproduces both
directions under the real boundary:

  A. identity      -- volume serial number and file index for plain, hard and
                      target names, so "same file" is a fact and not an inference
                      from `icacls`.
  B. descriptor    -- the raw security descriptor digest through each name.
  C. mutation      -- grant through one name, then compare the RAW BYTES of the
                      descriptor read back through the other name. `icacls` prints
                      inherited and explicit ACEs differently and prints nothing at
                      all for a SID it cannot resolve, so a string comparison of its
                      output is not a test of whether one change was seen by the
                      other name.
  D. containment   -- the real thing: a secret file with a second name inside a
                      workspace granted to the container. Reading it through the
                      granted directory must still refuse.
"""
import ctypes
import ctypes.wintypes as w
import hashlib
import json
import os
import subprocess
import tempfile

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
adv = ctypes.WinDLL("advapi32", use_last_error=True)
userenv = ctypes.WinDLL("userenv", use_last_error=True)

GENERIC_READ = 0x80000000
FILE_SHARE_ALL = 0x00000007
OPEN_EXISTING = 3
FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
SE_FILE_OBJECT = 1
DACL_SECURITY_INFORMATION = 0x00000004
CREATE_NO_WINDOW = 0x08000000
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009
INVALID_HANDLE_VALUE = w.HANDLE(-1).value
PROFILE_NAME = "lain.v3.probe"


class BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
    _fields_ = [("dwFileAttributes", w.DWORD), ("ftCreationTime", w.FILETIME),
                ("ftLastAccessTime", w.FILETIME), ("ftLastWriteTime", w.FILETIME),
                ("dwVolumeSerialNumber", w.DWORD), ("nFileSizeHigh", w.DWORD),
                ("nFileSizeLow", w.DWORD), ("nNumberOfLinks", w.DWORD),
                ("nFileIndexHigh", w.DWORD), ("nFileIndexLow", w.DWORD)]


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Sid", w.LPVOID), ("Attributes", w.DWORD)]


class SECURITY_CAPABILITIES(ctypes.Structure):
    _fields_ = [("AppContainerSid", w.LPVOID), ("Capabilities", ctypes.POINTER(SID_AND_ATTRIBUTES)),
                ("CapabilityCount", w.DWORD), ("Reserved", w.DWORD)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE),
                ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


k32.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
k32.CreateFileW.restype = w.HANDLE
k32.GetFileInformationByHandle.argtypes = [w.HANDLE, ctypes.POINTER(BY_HANDLE_FILE_INFORMATION)]
k32.GetFileInformationByHandle.restype = w.BOOL
adv.GetSecurityInfo.argtypes = [w.HANDLE, ctypes.c_int, w.DWORD, ctypes.POINTER(w.LPVOID),
                                ctypes.POINTER(w.LPVOID), ctypes.POINTER(w.LPVOID),
                                ctypes.POINTER(w.LPVOID), ctypes.POINTER(w.LPVOID)]
adv.GetSecurityInfo.restype = w.DWORD
adv.GetSecurityDescriptorLength.argtypes = [w.LPVOID]
adv.GetSecurityDescriptorLength.restype = w.DWORD
adv.ConvertSidToStringSidW.argtypes = [w.LPVOID, ctypes.POINTER(w.LPWSTR)]
adv.ConvertSidToStringSidW.restype = w.BOOL
userenv.DeriveAppContainerSidFromAppContainerName.argtypes = [w.LPCWSTR, ctypes.POINTER(w.LPVOID)]
userenv.DeriveAppContainerSidFromAppContainerName.restype = w.HRESULT
k32.InitializeProcThreadAttributeList.argtypes = [w.LPVOID, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)]
k32.UpdateProcThreadAttribute.argtypes = [w.LPVOID, w.DWORD, ctypes.c_size_t, w.LPVOID,
                                          ctypes.c_size_t, w.LPVOID, ctypes.POINTER(ctypes.c_size_t)]
k32.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, w.LPVOID, w.LPVOID, w.BOOL, w.DWORD,
                               w.LPVOID, w.LPCWSTR, w.LPVOID, ctypes.POINTER(PROCESS_INFORMATION)]
k32.CreateProcessW.restype = w.BOOL


def open_read(path):
    handle = k32.CreateFileW(path, GENERIC_READ, FILE_SHARE_ALL, None, OPEN_EXISTING,
                             FILE_FLAG_BACKUP_SEMANTICS, None)
    return (None, ctypes.get_last_error()) if handle == INVALID_HANDLE_VALUE else (handle, 0)


def identity(path):
    handle, err = open_read(path)
    if handle is None:
        return {"path": path, "error": err}
    try:
        info = BY_HANDLE_FILE_INFORMATION()
        if not k32.GetFileInformationByHandle(handle, ctypes.byref(info)):
            return {"path": path, "error": ctypes.get_last_error()}
        return {"path": path, "volume_serial": f"0x{info.dwVolumeSerialNumber:08X}",
                "file_id": f"{info.nFileIndexHigh:08X}{info.nFileIndexLow:08X}",
                "link_count": info.nNumberOfLinks}
    finally:
        k32.CloseHandle(handle)


def descriptor_bytes(path):
    """The descriptor's raw bytes, or the error that stopped us reading them."""
    handle, err = open_read(path)
    if handle is None:
        return {"path": path, "open_error": err}
    try:
        sd = w.LPVOID()
        rc = adv.GetSecurityInfo(handle, SE_FILE_OBJECT,
                                 DACL_SECURITY_INFORMATION, None, None, None, None, ctypes.byref(sd))
        if rc != 0:
            return {"path": path, "winerror": rc}
        try:
            header = ctypes.string_at(sd, 20)
            control = int.from_bytes(header[2:4], "little")
            if not (control & 0x8000):
                return {"path": path, "error": "descriptor is not self-relative"}
            offset_dacl = int.from_bytes(header[16:20], "little")
            length = 20
            if offset_dacl:
                acl_size = int.from_bytes(ctypes.string_at(sd, offset_dacl + 2)[0:2], "little")
                length = offset_dacl + acl_size
            blob = ctypes.string_at(sd, length)
            return {"path": path, "sd_bytes": length, "sd_sha256": hashlib.sha256(blob).hexdigest(),
                    "sd_hex": blob.hex()}
        finally:
            k32.LocalFree(sd)
    finally:
        k32.CloseHandle(handle)


def run_in_container(command, workdir, sid, timeout_ms=60_000):
    out_path = os.path.join(workdir, f"child-{os.urandom(4).hex()}.txt")
    handle = k32.CreateFileW(out_path, 0x40000000, 0x00000001 | 0x00000002, None, 2, 0x80, None)
    if handle == INVALID_HANDLE_VALUE:
        return {"started": False, "stage": "out_file", "winerror": ctypes.get_last_error()}
    buf = ctypes.create_string_buffer(112)
    ctypes.cast(buf, ctypes.POINTER(w.DWORD))[0] = 112
    ctypes.cast(ctypes.byref(buf, 60), ctypes.POINTER(w.DWORD))[0] = 0x00000100
    ctypes.cast(ctypes.byref(buf, 80), ctypes.POINTER(w.HANDLE))[0] = INVALID_HANDLE_VALUE
    ctypes.cast(ctypes.byref(buf, 88), ctypes.POINTER(w.HANDLE))[0] = handle
    ctypes.cast(ctypes.byref(buf, 96), ctypes.POINTER(w.HANDLE))[0] = handle
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
    pi = PROCESS_INFORMATION()
    cmdline = ctypes.create_unicode_buffer(command)
    ok = k32.CreateProcessW(None, cmdline, None, None, True,
                            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                            None, workdir, ctypes.byref(buf), ctypes.byref(pi))
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
        return {"started": True, "exit_code": code.value, "output": fh.read().strip()}


def main():
    report = {}
    base = tempfile.mkdtemp(prefix="lain-hl-")
    ws = os.path.join(base, "ws")
    secret = os.path.join(base, "secret")
    os.makedirs(ws)
    os.makedirs(secret)
    report["base"] = base

    # The matrix's shape: a secret outside, a second name for it inside.
    outside_file = os.path.join(secret, "secret.txt")
    link_inside = os.path.join(ws, "hard.txt")
    with open(outside_file, "w", encoding="utf-8") as fh:
        fh.write("SECRET-MARKER")
    made = subprocess.run(["cmd", "/c", "mklink", "/H", link_inside, outside_file],
                          capture_output=True, text=True)
    report["mklink"] = {"rc": made.returncode, "out": (made.stdout or made.stderr).strip()}

    # Two distinct files that live in DIFFERENT directories, one granted and one
    # not -- the case that tells "per-file" apart from "per-directory".
    granted_file = os.path.join(ws, "plain.txt")
    with open(granted_file, "w", encoding="utf-8") as fh:
        fh.write("GRANTED-MARKER")

    report["identity"] = {
        "outside": identity(outside_file),
        "link_inside": identity(link_inside),
        "granted_file": identity(granted_file),
    }
    same = (report["identity"]["outside"].get("file_id") == report["identity"]["link_inside"].get("file_id")
            and report["identity"]["outside"].get("volume_serial") == report["identity"]["link_inside"].get("volume_serial"))
    report["link_and_target_are_one_file"] = same
    report["granted_file_is_a_different_file"] = (
        report["identity"]["granted_file"].get("file_id") != report["identity"]["outside"].get("file_id"))

    # Descriptor before any change.
    report["descriptor_before"] = {
        "outside": descriptor_bytes(outside_file),
        "link_inside": descriptor_bytes(link_inside),
        "granted_file": descriptor_bytes(granted_file),
    }

    # Mutate through the OUTSIDE name and read back through the INSIDE name, on raw
    # bytes. If the two names had one descriptor, the bytes change under both.
    sid_user = "S-1-5-21-3412152243-2925446466-2272665338-1001"
    mutate = subprocess.run(["icacls", outside_file, "/grant", f"*{sid_user}:(R)"], capture_output=True, text=True)
    report["mutate_through_outside"] = {"rc": mutate.returncode, "out": (mutate.stdout or mutate.stderr).strip()}
    after = {"outside": descriptor_bytes(outside_file), "link_inside": descriptor_bytes(link_inside)}
    report["descriptor_after"] = after
    report["mutation_seen_through_link"] = (
        after["outside"].get("sd_hex") == after["link_inside"].get("sd_hex"))
    report["mutation_changed_the_descriptor"] = (
        after["outside"].get("sd_hex") != report["descriptor_before"]["outside"].get("sd_hex"))
    report["granted_file_unchanged_by_the_mutation"] = (
        descriptor_bytes(granted_file).get("sd_hex") == report["descriptor_before"]["granted_file"].get("sd_hex"))

    # D. Under the real boundary.
    sid_buf = w.LPVOID()
    hr = userenv.DeriveAppContainerSidFromAppContainerName(PROFILE_NAME, ctypes.byref(sid_buf))
    if hr != 0:
        report["container"] = {"derive_hr": f"0x{hr & 0xFFFFFFFF:08X}"}
    else:
        sid_str = w.LPWSTR()
        adv.ConvertSidToStringSidW(sid_buf, ctypes.byref(sid_str))
        report["container_sid"] = sid_str.value
        k32.LocalFree(sid_str)
        grant = subprocess.run(["icacls", ws, "/grant", f"*{report['container_sid']}:(OI)(CI)M"],
                               capture_output=True, text=True)
        report["grant_workspace"] = {"rc": grant.returncode}
        node = r"C:\Program Files\nodejs\node.exe"
        script = os.path.join(ws, "probe.mjs")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write(
                "import { readFileSync } from 'node:fs';\n"
                f"const targets = {json.dumps({'granted': granted_file, 'hardlink_to_secret': link_inside, 'secret_direct': outside_file})};\n"
                "const out = {};\n"
                "for (const [k, p] of Object.entries(targets)) {\n"
                "  try { out[k] = 'READ:' + readFileSync(p, 'utf8').trim().slice(0, 14); }\n"
                "  catch (e) { out[k] = e.code + '/' + e.errno; }\n"
                "}\n"
                "console.log('MARKER ' + JSON.stringify(out));\n")
        report["container_reads"] = run_in_container(f'"{node}" "{script}"', ws, sid_buf)

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
