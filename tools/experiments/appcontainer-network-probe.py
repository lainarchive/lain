"""Can a tool inside Lain's AppContainer reach the network?

Runs through the SHIPPED supervisor rather than a hand-rolled CreateProcessW. That
is deliberate: two of my own probes returned exit 0 with empty output and looked
like denials, because getting an inheritable stdout handle right is easy to get
wrong, and a wire that does not work is indistinguishable from a boundary that
denies everything. `tools/win32/job_host.py` already writes output to files the
container can reach -- proven by the CLI end-to-end run -- so the measurement uses
it and the wire is not in question.

The script is written into a directory granted to the container SID, because a
container cannot read its own script from an ungranted directory.

Each case runs twice, unrestricted and contained, with the identical command. A
failed control makes the container result inconclusive rather than a denial.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

PYTHON = r"C:\Python315\python.exe"
REPO = r"C:\Users\frick\Documents\Projects\lain"
HELPER = os.path.join(REPO, "tools", "win32", "job_host.py")
NODE = r"C:\Program Files\nodejs\node.exe"
CONTAINER = "lain.tool.runner"


def sid_of(profile):
    """The SID for an AppContainer profile name, via icacls' own lookup.

    `icacls /grant *<sid>` needs the text form, and the only supported way to get
    it here is the same derivation the supervisor uses. Asking icacls to resolve
    the name is not possible, so the supervisor's own helper is reused by invoking
    the probe path it exposes: `job_host.py --sid <profile>`.
    """
    out = subprocess.run([PYTHON, HELPER, "--sid", profile], capture_output=True, text=True)
    return (out.stdout or "").strip() or None


def run_spec(spec, root, label):
    spec_path = os.path.join(root, f"{label}.spec.json")
    result_path = os.path.join(root, f"{label}.result.json")
    with open(spec_path, "w", encoding="utf-8") as fh:
        json.dump(spec, fh)
    sup = subprocess.run([PYTHON, HELPER, spec_path, result_path],
                         capture_output=True, text=True, timeout=120)
    report = {"supervisor_exit": sup.returncode}
    if os.path.exists(result_path):
        with open(result_path, "r", encoding="utf-8", errors="replace") as fh:
            report["result"] = json.load(fh)
    else:
        report["result"] = None
        report["supervisor_stderr"] = (sup.stderr or "").strip()[:600]
    return report


def main():
    root = tempfile.mkdtemp(prefix="lain-net2-")
    report = {"root": root, "wire": "the shipped supervisor, so stdout is a file it opened"}

    sid = sid_of(CONTAINER)
    report["container_sid"] = sid
    if not sid:
        report["fatal"] = "the container SID could not be resolved; the supervisor may not expose --sid"
        print(json.dumps(report, indent=2))
        return

    # A listener only this machine can reach, open for the duration.
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(4)
    port = server.getsockname()[1]
    print(f"# localhost listener on 127.0.0.1:{port}", file=sys.stderr)

    def accept_once():
        try:
            conn, _ = server.accept()
            conn.sendall(b"LOCAL-OK\n")
            conn.close()
        except OSError:
            pass

    threading.Thread(target=accept_once, daemon=True).start()

    script = (
        "const net = require('node:net');\n"
        "const dns = require('node:dns');\n"
        "const out = {};\n"
        "let pending = 3;\n"
        "const step = () => { if (--pending === 0) console.log(JSON.stringify(out, null, 2)); };\n"
        f"const s = net.connect({port}, '127.0.0.1');\n"
        "s.setTimeout(4000);\n"
        "s.on('data', (d) => { out.localhost = 'ALLOWED ' + d.toString().trim(); s.end(); step(); });\n"
        "s.on('error', (e) => { out.localhost = 'DENIED ' + e.code; step(); });\n"
        "s.on('timeout', () => { out.localhost = 'DENIED timeout'; s.destroy(); step(); });\n"
        "const o = net.connect(80, '93.184.216.34');\n"
        "o.setTimeout(5000);\n"
        "o.on('connect', () => { out.outbound = 'ALLOWED'; o.destroy(); step(); });\n"
        "o.on('error', (e) => { out.outbound = 'DENIED ' + e.code; step(); });\n"
        "o.on('timeout', () => { out.outbound = 'DENIED timeout'; o.destroy(); step(); });\n"
        "dns.lookup('example.com', (err, addr) => {\n"
        "  out.dns = err ? 'DENIED ' + err.code : 'ALLOWED ' + addr; step(); });\n"
    )

    # The script lives where the container may read it.
    granted = os.path.join(root, "granted")
    os.makedirs(granted, exist_ok=True)
    script_path = os.path.join(granted, "net-probe.cjs")
    with open(script_path, "w", encoding="utf-8") as fh:
        fh.write(script)
    grant = subprocess.run(["icacls", granted, "/grant", f"*{sid}:(OI)(CI)RX"],
                           capture_output=True, text=True)
    report["grant"] = {"rc": grant.returncode, "out": (grant.stdout or "").strip()}

    env = {k: os.environ[k] for k in ("PATH", "SystemRoot", "COMSPEC", "PATHEXT") if k in os.environ}
    env["LOCALAPPDATA"] = os.environ.get("LOCALAPPDATA", "")
    env["TEMP"] = granted
    env["TMP"] = granted

    base_spec = {
        "command": NODE,
        "args": [script_path],
        "cwd": granted,
        "env": env,
        "output_bytes": 65_536,
        "supervisor_ms": 60_000,
        "job_ms": 60_000,
        "process_memory_bytes": 256 * 1024 * 1024,
    }

    report["control_unrestricted"] = run_spec(dict(base_spec), root, "control")
    # The container needs the profile name it ships with.
    contained = dict(base_spec)
    contained["container"] = CONTAINER
    report["appcontainer"] = run_spec(contained, root, "container")
    server.close()
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
