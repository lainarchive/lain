"""Do two hard-link names really share one security descriptor?

The V-3 report claimed that hard links do not launder access, that a link and its
target share one security descriptor, and that `icacls` showed an ACE on
`ws\\plain.txt` but not on `ws\\hard.txt`. Those three claims cannot all be
evidence for each other, and the review is right to say so: the matrix planted
`hard.txt` as a second name for a file in an UNGRANTED directory, so "hard.txt is
refused" says nothing about whether the two names share a descriptor. It is
consistent with it, and it is also consistent with a per-name descriptor.

This probe asks the question directly, with the API rather than with `icacls`:

  GetFileInformationByHandle on every name -> volume serial number + file index.
  Two names with the same pair are the same file, and that is a fact rather than
  an inference from `icacls` output.

  GetSecurityInfo(FILE_ALL) on the SAME file opened through each name -> the
  descriptor bytes and the SHA-256 of those bytes. If the file has one descriptor,
  the two digests are equal; if it has one per name, they differ.

  An ACE change made through one name, read back through the other -> the strongest
  and least ambiguous form of the question, because it does not depend on how a
  descriptor is compared.

Nothing here is inside an AppContainer: this is about NTFS and the ACL, and the
container is the next question rather than this one.
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

GENERIC_READ = 0x80000000
FILE_SHARE_ALL = 0x00000007
OPEN_EXISTING = 3
FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
SE_FILE_OBJECT = 1
DACL_SECURITY_INFORMATION = 0x00000004
OWNER_SECURITY_INFORMATION = 0x00000001
GROUP_SECURITY_INFORMATION = 0x00000002


class BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
    _fields_ = [("dwFileAttributes", w.DWORD),
                ("ftCreationTime", w.FILETIME),
                ("ftLastAccessTime", w.FILETIME),
                ("ftLastWriteTime", w.FILETIME),
                ("dwVolumeSerialNumber", w.DWORD),
                ("nFileSizeHigh", w.DWORD),
                ("nFileSizeLow", w.DWORD),
                ("nNumberOfLinks", w.DWORD),
                ("nFileIndexHigh", w.DWORD),
                ("nFileIndexLow", w.DWORD)]


k32.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
k32.CreateFileW.restype = w.HANDLE
k32.GetFileInformationByHandle.argtypes = [w.HANDLE, ctypes.POINTER(BY_HANDLE_FILE_INFORMATION)]
k32.GetFileInformationByHandle.restype = w.BOOL
adv.GetSecurityInfo.argtypes = [w.HANDLE, ctypes.c_int, w.DWORD, ctypes.POINTER(w.LPVOID),
                                ctypes.POINTER(w.LPVOID), ctypes.POINTER(w.LPVOID),
                                ctypes.POINTER(w.LPVOID), ctypes.POINTER(w.LPVOID)]
adv.GetSecurityInfo.restype = w.DWORD
INVALID_HANDLE_VALUE = w.HANDLE(-1).value


def open_file(path):
    handle = k32.CreateFileW(path, GENERIC_READ, FILE_SHARE_ALL, None, OPEN_EXISTING,
                             FILE_FLAG_BACKUP_SEMANTICS, None)
    if handle == INVALID_HANDLE_VALUE:
        return None, ctypes.get_last_error()
    return handle, 0


def identity(path):
    """Volume serial number and file index -- the pair that names one file."""
    handle, err = open_file(path)
    if handle is None:
        return {"path": path, "error": err, "message": ctypes.FormatError(err).strip()}
    try:
        info = BY_HANDLE_FILE_INFORMATION()
        if not k32.GetFileInformationByHandle(handle, ctypes.byref(info)):
            err = ctypes.get_last_error()
            return {"path": path, "error": err}
        return {
            "path": path,
            "volume_serial": f"0x{info.dwVolumeSerialNumber:08X}",
            "file_id": f"{info.nFileIndexHigh:08X}{info.nFileIndexLow:08X}",
            "link_count": info.nNumberOfLinks,
            "size": (info.nFileSizeHigh << 32) | info.nFileSizeLow,
        }
    finally:
        k32.CloseHandle(handle)


def descriptor(path):
    """The file's security descriptor bytes, through this name, as a digest."""
    handle, err = open_file(path)
    if handle is None:
        return {"path": path, "error": err}
    try:
        sd = w.LPVOID()
        rc = adv.GetSecurityInfo(handle, SE_FILE_OBJECT,
                                 DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION,
                                 None, None, None, None, ctypes.byref(sd))
        if rc != 0:
            return {"path": path, "winerror": rc}
        try:
            # Read the header to learn the descriptor's length, then hash its bytes.
            # SECURITY_DESCRIPTOR is self-relative here (GetSecurityInfo returns one),
            # so the control field's SE_SELF_RELATIVE bit says the layout.
            raw = ctypes.string_at(sd, 20)
            control = int.from_bytes(raw[2:4], "little")
            if not (control & 0x8000):
                return {"path": path, "error": "descriptor is not self-relative"}
            offset_dacl = int.from_bytes(raw[16:20], "little")
            length = offset_dacl if offset_dacl else 20
            # Walk the DACL to find its end, so the digest covers the whole thing.
            if offset_dacl:
                acl_size = int.from_bytes(ctypes.string_at(sd, offset_dacl + 2)[0:2], "little")
                length = max(length, offset_dacl + acl_size)
            blob = ctypes.string_at(sd, length)
            return {"path": path, "sd_bytes": length, "sd_sha256": hashlib.sha256(blob).hexdigest()}
        finally:
            k32.LocalFree(sd)
    finally:
        k32.CloseHandle(handle)


def icacls(path):
    done = subprocess.run(["icacls", path], capture_output=True, text=True)
    lines = [ln.strip() for ln in done.stdout.splitlines() if ln.strip()]
    return lines[1:] if len(lines) > 1 else lines


def main():
    report = {}
    base = tempfile.mkdtemp(prefix="lain-hardlink-")
    ws = os.path.join(base, "ws")
    secret = os.path.join(base, "secret")
    os.makedirs(ws)
    os.makedirs(secret)
    plain = os.path.join(ws, "plain.txt")
    target = os.path.join(secret, "secret.txt")
    hard = os.path.join(ws, "hard.txt")
    with open(plain, "w", encoding="utf-8") as fh:
        fh.write("GRANTED-MARKER")
    with open(target, "w", encoding="utf-8") as fh:
        fh.write("SECRET-MARKER")
    made = subprocess.run(["cmd", "/c", "mklink", "/H", hard, target],
                          capture_output=True, text=True)
    report["mklink_hard"] = {"rc": made.returncode, "out": (made.stdout or made.stderr).strip()}
    report["base"] = base

    # 1. Are the names the same file?
    report["identity_plain"] = identity(plain)
    report["identity_hard"] = identity(hard)
    report["identity_target"] = identity(target)
    report["plain_and_hard_same_file"] = (
        report["identity_plain"].get("file_id") == report["identity_hard"].get("file_id")
        and report["identity_plain"].get("volume_serial") == report["identity_hard"].get("volume_serial"))
    report["hard_and_target_same_file"] = (
        report["identity_hard"].get("file_id") == report["identity_target"].get("file_id"))

    # 2. One descriptor or two?
    report["descriptor_plain"] = descriptor(plain)
    report["descriptor_hard"] = descriptor(hard)
    report["descriptor_identical"] = (
        report["descriptor_plain"].get("sd_sha256") == report["descriptor_hard"].get("sd_sha256"))

    # 3. Change an ACE through one name, read it back through the other. This does
    #    not depend on how two descriptors are compared: if the names had separate
    #    descriptors, the other name would not see the change.
    sid = "S-1-5-21-3412152243-2925446466-2272665338-1001"  # this user
    before_hard = icacls(hard)
    grant = subprocess.run(["icacls", plain, "/grant", f"*{sid}:(R)"], capture_output=True, text=True)
    after_hard = icacls(hard)
    report["icacls_plain_before"] = icacls(plain)
    report["icacls_hard_before"] = before_hard
    report["ace_added_via_plain"] = {"rc": grant.returncode, "out": (grant.stdout or "").strip()}
    report["icacls_hard_after_ace_added_via_plain"] = after_hard
    report["ace_change_visible_through_hard"] = before_hard != after_hard

    # 4. What icacls prints for each name -- the presentation question.
    report["icacls_plain_after"] = icacls(plain)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
