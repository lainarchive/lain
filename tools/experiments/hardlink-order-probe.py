"""Does a hard link inside a granted directory let the container read the object?

The test suite says one thing and a manual run said another, so this settles it
without the test runner in the way. Sequence, deliberately in this order:

  1. create ws and ws\\denied, strip inheritance on denied so the container has no
     ACE for it through its parent;
  2. write the secret in denied;
  3. make a hard link to it inside ws;
  4. grant ws to the container with (OI)(CI)M -- the same grant the runner makes;
  5. read the secret and the link from inside the container.

The ACL of the object is printed at each step, because "the container could read
it" and "the object carries an ACE for the container" are different observations
and the second explains the first.
"""
import ctypes
import ctypes.wintypes as w
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
from importlib import import_module

probe = import_module("hardlink-containment-probe") if False else None

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import importlib.util

spec = importlib.util.spec_from_file_location(
    "hlc", os.path.join(HERE, "hardlink-containment-probe.py"))
hlc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hlc)

OWNER = f"{os.environ['USERDOMAIN']}\\{os.environ['USERNAME']}"


def icacls(path):
    done = subprocess.run(["icacls", path], capture_output=True, text=True)
    return " ".join(done.stdout.split())


def main():
    base = tempfile.mkdtemp(prefix="lain-hl-order-")
    ws = os.path.join(base, "ws")
    denied = os.path.join(ws, "denied")
    os.makedirs(denied)
    subprocess.run(["icacls", denied, "/inheritance:r", "/grant:r", f"{OWNER}:(OI)(CI)F", "/Q"],
                   capture_output=True, text=True)

    hidden = os.path.join(denied, "hidden.txt")
    link = os.path.join(ws, "link.txt")
    with open(hidden, "w", encoding="utf-8") as fh:
        fh.write("DENIED-MARKER")
    with open(os.path.join(ws, "granted.txt"), "w", encoding="utf-8") as fh:
        fh.write("GRANTED-MARKER")

    made = subprocess.run(["cmd", "/c", "mklink", "/H", link, hidden], capture_output=True, text=True)
    report = {"base": base, "mklink_rc": made.returncode}

    sid_buf = w.LPVOID()
    hr = hlc.userenv.DeriveAppContainerSidFromAppContainerName(hlc.PROFILE_NAME, ctypes.byref(sid_buf))
    sid_str = w.LPWSTR()
    hlc.adv.ConvertSidToStringSidW(sid_buf, ctypes.byref(sid_str))
    sid = sid_str.value
    hlc.k32.LocalFree(sid_str)
    report["sid"] = sid

    report["acl_hidden_before_grant"] = icacls(hidden)
    report["acl_denied_before_grant"] = icacls(denied)

    grant = subprocess.run(["icacls", ws, "/grant", f"*{sid}:(OI)(CI)M"], capture_output=True, text=True)
    report["grant_rc"] = grant.returncode
    report["acl_hidden_after_grant"] = icacls(hidden)
    report["acl_denied_after_grant"] = icacls(denied)
    report["acl_link_after_grant"] = icacls(link)
    report["object_carries_container_ace"] = sid.lower() in report["acl_hidden_after_grant"].lower()

    script = os.path.join(ws, "probe.mjs")
    with open(script, "w", encoding="utf-8") as fh:
        fh.write(
            "import { readFileSync } from 'node:fs';\n"
            f"const files = {json.dumps({'granted': os.path.join(ws, 'granted.txt'), 'secret_direct': hidden, 'secret_via_link': link})};\n"
            "const out = {};\n"
            "for (const [k, p] of Object.entries(files)) {\n"
            "  try { out[k] = 'READ:' + readFileSync(p, 'utf8').trim(); }\n"
            "  catch (e) { out[k] = e.code + '/' + e.errno; }\n"
            "}\n"
            "console.log('MARKER ' + JSON.stringify(out));\n")
    node = r"C:\Program Files\nodejs\node.exe"
    report["container"] = hlc.run_in_container(f'"{node}" "{script}"', ws, sid_buf)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
