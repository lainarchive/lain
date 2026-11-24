"""Rerun the Terminal-Bench head to head: Lain against stock Terminus-2.

One command does the whole run:

    python3 tools/terminal-bench/run.py

Both agents get the same task list and the same upstream model, reached through
a local proxy on the Docker bridge. The proxy exists because the task containers
cannot reach a host listening on 127.0.0.1, and because it lets both agents share
one upstream credential and one model name without either seeing the real key.

Per-task results land in a Markdown table next to the harbor job dirs; the whole
run lives outside the repository so `job.log` files never become committable
artifacts.
"""

import argparse
import concurrent.futures
import http.client
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
BRIDGE = "172.17.0.1"
DEFAULT_MODEL = "hy4-flash:free"
DEFAULT_BASE_URL = "https://api.cent-ai.dev/v1"
DEFAULT_KEY_ENV = "CENTAI_API_KEY"
DEFAULT_DATASET = "terminal-bench@2.0"
MAX_BYTES = 256000
REQUESTS = threading.BoundedSemaphore(16)
POOL = concurrent.futures.ThreadPoolExecutor(64)


def fetch(upstream, timeout):
    with urllib.request.urlopen(upstream, timeout=timeout) as response:
        return response.code, response.headers.get("Content-Type", "application/json"), response.read()


class ModelProxy(BaseHTTPRequestHandler):
    upstream_url = DEFAULT_BASE_URL
    key_env = DEFAULT_KEY_ENV
    model = DEFAULT_MODEL
    access = ""
    # The pinned request is only half the contract: a free router may answer
    # with a fallback model and silently void the head to head, so every 200 is
    # checked against the promised name (the served-model parity rule in
    # oh-my-hermes' paired-run provenance, MIT: github.com/rlaope/oh-my-hermes).
    served_mismatch = 0
    served_seen = set()
    served_lock = threading.Lock()
    # Per-arm access tokens and observed usage: which agent asked, how many
    # replies failed upstream, and the tokens it consumed — evidence records in
    # the style of oh-my-hermes' routing_observation (MIT), never verdicts.
    access_tokens = {}
    arm_stats = {}
    stats_lock = threading.Lock()

    def log_message(self, *args):
        pass

    def check_served_model(self, code, content_type, body):
        if code != 200 or "json" not in content_type:
            return
        try:
            served = json.loads(body).get("model")
        except (json.JSONDecodeError, AttributeError):
            return
        if isinstance(served, str) and served != self.model:
            with type(self).served_lock:
                type(self).served_mismatch += 1
                type(self).served_seen.add(served)
            print(f"served model {served!r} != pinned {self.model}", flush=True)

    @classmethod
    def access_arm(cls, header):
        for arm, token in cls.access_tokens.items():
            if secrets.compare_digest(header, f"Bearer {token}"):
                return arm
        return None

    def record_result(self, arm, code, content_type, body):
        with type(self).stats_lock:
            stats = type(self).arm_stats.setdefault(
                arm, {"requests": 0, "errors": 0, "prompt_tokens": 0, "completion_tokens": 0}
            )
            stats["requests"] += 1
            if code != 200:
                stats["errors"] += 1
        self.check_served_model(code, content_type, body)
        if code != 200 or "json" not in content_type:
            return
        try:
            usage = json.loads(body).get("usage") or {}
        except (json.JSONDecodeError, AttributeError):
            return
        prompt = usage.get("prompt_tokens") or 0
        completion = usage.get("completion_tokens") or 0
        if isinstance(prompt, int) and isinstance(completion, int) and (prompt or completion):
            with type(self).stats_lock:
                stats["prompt_tokens"] += prompt
                stats["completion_tokens"] += completion

    def do_POST(self):
        arm = self.access_arm(self.headers.get("Authorization", ""))
        if self.path != "/v1/chat/completions" or arm is None:
            self.send_error(403)
            return
        self.arm = arm
        try:
            length = int(self.headers["Content-Length"])
            if not 0 < length <= MAX_BYTES:
                raise ValueError()
            payload = json.loads(self.rfile.read(length))
            if payload.get("model") != self.model:
                self.send_error(400, f"this run pins the model to {self.model}")
                return
            fields = {"messages", "tools", "tool_choice", "temperature", "stream", "stream_options"}
            data = {key: value for key, value in payload.items() if key in fields}
            data["model"] = self.model
            data["max_tokens"] = min(int(payload.get("max_tokens", 8192)), 8192)
            if not 0 < data["max_tokens"] or not isinstance(data.get("messages"), list):
                raise ValueError()
        except (ValueError, AttributeError, TypeError, KeyError):
            self.send_error(400)
            return
        if not REQUESTS.acquire(timeout=60):
            self.send_error(429)
            return
        try:
            code, content_type, body = self.forward(data)
        finally:
            REQUESTS.release()
        try:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionError, TimeoutError):
            pass

    def forward(self, data):
        # Buffer the whole upstream reply so a dropped stream or rate limit is retried before the agent sees it.
        code, content_type, body = 502, "application/json", b'{"error":"upstream unavailable"}'
        deadline = time.monotonic() + 110  # just under the agent-side provider timeout of 120 s
        for attempt in range(5):
            if attempt:
                time.sleep(min(2 ** attempt, 20))
            if time.monotonic() > deadline - 5:
                break
            upstream = urllib.request.Request(
                self.upstream_url.rstrip("/") + "/chat/completions",
                data=json.dumps(data).encode(),
                headers={
                    "Authorization": f"Bearer {os.environ[self.key_env]}",
                    "Content-Type": "application/json",
                },
            )
            started = time.monotonic()
            try:
                # A hung upstream reply trickles bytes past socket timeouts; bound each attempt's total time.
                remaining = deadline - started
                result = POOL.submit(fetch, upstream, remaining).result(timeout=remaining)
                print(f"upstream {result[0]} {time.monotonic() - started:.3f}s", flush=True)
                self.record_result(self.arm, *result)
                return result
            except urllib.error.HTTPError as error:
                code, content_type, body = error.code, error.headers.get("Content-Type", "application/json"), error.read()
                print(f"upstream {error.code} attempt {attempt + 1}: {body[:300]!r}", flush=True)
                if error.code not in (403, 408, 429) and error.code < 500:
                    return code, content_type, body
            except (TimeoutError, urllib.error.URLError, http.client.HTTPException, ConnectionError, concurrent.futures.TimeoutError) as error:
                print(f"upstream {type(error).__name__} attempt {attempt + 1}", flush=True)
        return code, content_type, body


def harbor_bin(override):
    found = override or shutil.which("harbor") or str(Path.home() / ".local/bin/harbor")
    if not Path(found).exists() and not shutil.which(found):
        raise SystemExit(f"harbor not found at {found}; install it with: uv tool install harbor")
    return found


def build_lain(path):
    binary = Path(path).resolve()
    if binary.exists():
        return binary
    print(f"building Lain: cargo build --release -> {binary}", flush=True)
    subprocess.run(["cargo", "build", "--release"], cwd=REPO, check=True)
    if not binary.exists():
        raise SystemExit(f"cargo build finished but {binary} is missing")
    return binary


def dataset_args(args):
    if args.dataset_path:
        return ["-p", str(Path(args.dataset_path).resolve())]
    return ["-d", args.dataset]


def run_agent(args, proxy_url, which, tasks, env):
    job_name = f"{args.job_name}-{which}"
    cmd = [
        args.harbor, "run",
        *dataset_args(args),
        "--jobs-dir", args.jobs_dir,
        "--job-name", job_name,
        "--no-force-build",
        "--n-concurrent", str(args.concurrency),
    ]
    if args.timeout_multiplier:
        cmd += ["--timeout-multiplier", str(args.timeout_multiplier)]
    if which == "lain":
        cmd += ["-a", "lain_adapter:LainAgent", "-m", ModelProxy.model]
    else:
        # Terminus-2 talks LiteLLM; the openai/ prefix selects its OpenAI-compatible transport.
        cmd += ["-a", "terminus-2", "-m", f"openai/{ModelProxy.model}",
                "--base-url", proxy_url, "--api-key-name", "LAIN_BENCH_ACCESS"]
    for task in tasks:
        cmd += ["-i", task]
    print(f"harbor: {' '.join(cmd)}", flush=True)
    return subprocess.call(cmd, env=env)


def read_trials(jobs_dir, job_name):
    job_dir = Path(jobs_dir) / job_name
    trials = {}
    if not job_dir.is_dir():
        return trials
    for result_path in sorted(job_dir.glob("*__*/result.json")):
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        task = result.get("task_name", result_path.parent.name).split("/")[-1]
        rewards = (result.get("verifier_result") or {}).get("rewards") or {}
        reward = rewards.get("reward")
        exception = (result.get("exception_info") or {}).get("exception_type")
        trials[task] = {"reward": reward, "exception": exception}
    return trials


def status_cell(trial):
    if trial is None:
        return "-"
    if trial["exception"]:
        return f"error ({trial['exception']})"
    if trial["reward"] == 1.0:
        return "pass"
    if trial["reward"] == 0.0:
        return "fail"
    return "unknown"


def write_table(args, tasks, lain, terminus, out_path):
    agents = [("Lain", lain), ("Terminus-2", terminus)]
    served = (
        "ok" if not ModelProxy.served_mismatch
        else f"{ModelProxy.served_mismatch} replies from {', '.join(sorted(ModelProxy.served_seen))}"
    )
    usage = "; ".join(
        f"{arm} {s['requests']}req/{s['errors']}err/{s['prompt_tokens']}+{s['completion_tokens']}tok"
        for arm, s in sorted(ModelProxy.arm_stats.items())
    ) or "none observed"
    lines = [
        f"<!-- {args.dataset_path or args.dataset} | model {ModelProxy.model} via {ModelProxy.upstream_url}",
        f"     | lain revision {args.revision} | served-model check {served} | arm usage {usage}",
        f"     | {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} -->",
        "",
        "| Task | Lain | Terminus-2 |",
        "| --- | --- | --- |",
    ]
    totals = {name: {"pass": 0, "fail": 0, "error": 0, "unknown": 0} for name, _ in agents}
    for task in tasks:
        row = [task]
        for name, trials in agents:
            cell = status_cell(trials.get(task))
            totals[name]["pass" if cell == "pass" else "fail" if cell == "fail"
                        else "error" if cell.startswith("error") else "unknown"] += 1
            row.append(cell)
        lines.append("| " + " | ".join(row) + " |")
    # Scores carry their basis, omh_reported_rate style (MIT): the numerator's
    # bucket, what the denominator counted, and every excluded observation
    # class; an arm with no observed trials is "no observations", never 0%.
    def score(name):
        t = totals[name]
        observed = t["pass"] + t["fail"]
        if observed == 0:
            return "no trials observed" + (
                f" ({t['error']} error, {t['unknown']} unknown)" if t["error"] or t["unknown"] else ""
            )
        excluded = f"{t['error']} error, {t['unknown']} unknown" if t["error"] or t["unknown"] else "none excluded"
        return f"**{t['pass']}/{observed}** pass ({excluded})"
    lines.append("| **Score** | " + " | ".join(score(name) for name, _ in agents) + " |")
    lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")
    return "\n".join(lines[3:])


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="tools/terminal-bench/run.py",
        description="Rerun the Terminal-Bench head to head: Lain against Terminus-2 on one task list and one model.",
    )
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"upstream model (default: {DEFAULT_MODEL})")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"upstream OpenAI-compatible endpoint (default: {DEFAULT_BASE_URL})")
    parser.add_argument("--api-key-env", default=DEFAULT_KEY_ENV, help=f"env var holding the upstream key (default: {DEFAULT_KEY_ENV})")
    parser.add_argument("--tasks", help="comma-separated task names (default: the pinned list in tasks.txt)")
    parser.add_argument("--tasks-file", default=HERE / "tasks.txt", type=Path)
    parser.add_argument("--dataset", default=DEFAULT_DATASET, help=f"harbor dataset name@version (default: {DEFAULT_DATASET})")
    parser.add_argument("--dataset-path", help="local task/dataset directory; overrides --dataset")
    parser.add_argument("--jobs-dir", default=str(Path.home() / ".cache" / "lain" / "terminal-bench" / "jobs"),
                        help="where harbor jobs and the results table land (default: ~/.cache/lain/terminal-bench/jobs)")
    parser.add_argument("--job-name", default="h2h", help="job name prefix; agents run as <prefix>-lain and <prefix>-terminus-2")
    parser.add_argument("--concurrency", type=int, default=3, help="concurrent trials per agent (default: 3; keep low on free tiers)")
    parser.add_argument("--timeout-multiplier", type=float, help="harbor timeout multiplier")
    parser.add_argument("--lain-binary", default=str(REPO / "target" / "release" / "lain"),
                        help="path to the Lain binary (built with cargo --release if missing)")
    parser.add_argument("--harbor", help="harbor executable (default: PATH, then ~/.local/bin/harbor)")
    parser.add_argument("--agents", default="lain,terminus-2", help="comma-separated subset for partial runs")
    parser.add_argument("--revision", help="recorded Lain revision (default: git HEAD)")
    parser.add_argument("--bind", default=BRIDGE, help=f"address the proxy listens on (default: {BRIDGE}, the Docker bridge gateway)")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    if args.api_key_env not in os.environ:
        raise SystemExit(f"missing ${args.api_key_env}; the free tier needs only a key, no payment")
    ModelProxy.model = args.model
    ModelProxy.upstream_url = args.base_url
    ModelProxy.key_env = args.api_key_env
    ModelProxy.access_tokens = {arm: secrets.token_hex(32) for arm in ("lain", "terminus-2")}

    tasks = [line for line in (line.strip() for line in (args.tasks or args.tasks_file.read_text(encoding="utf-8")).replace(",", "\n").splitlines())
             if line and not line.startswith("#")]
    if not tasks:
        raise SystemExit("empty task list")

    args.harbor = harbor_bin(args.harbor)
    args.revision = args.revision or subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True, check=True
    ).stdout.strip()
    selected = {name.strip() for name in args.agents.split(",")}
    if unknown := selected - {"lain", "terminus-2"}:
        raise SystemExit(f"unknown agents: {', '.join(sorted(unknown))} (choices: lain, terminus-2)")
    binary = build_lain(args.lain_binary) if "lain" in selected else None

    Path(args.jobs_dir).mkdir(parents=True, exist_ok=True)
    with ThreadingHTTPServer((args.bind, 0), ModelProxy) as proxy:
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        proxy_url = f"http://{args.bind}:{proxy.server_port}/v1"
        # The upstream key stays in this process; containers and harbor config only ever see the proxy token.
        env = {key: value for key, value in os.environ.items() if key != args.api_key_env}
        env.update(
            PYTHONPATH=str(HERE),
            PYTHONUNBUFFERED="1",
            LAIN_BENCH_REVISION=args.revision,
            LAIN_BENCH_BINARY=str(binary or ""),
            LAIN_BENCH_PROXY_URL=proxy_url,
        )
        failures = []
        try:
            for which in ("lain", "terminus-2"):
                if which not in selected:
                    continue
                arm_env = dict(env, LAIN_BENCH_ACCESS=ModelProxy.access_tokens[which])
                if run_agent(args, proxy_url, which, tasks, arm_env):
                    failures.append(which)
        finally:
            proxy.shutdown()
        for arm, stats in sorted(ModelProxy.arm_stats.items()):
            print(
                f"{arm}: {stats['requests']} requests, {stats['errors']} upstream errors, "
                f"{stats['prompt_tokens']} prompt + {stats['completion_tokens']} completion tokens",
                flush=True,
            )
        if ModelProxy.served_mismatch:
            print(
                f"WARNING: upstream served {ModelProxy.served_mismatch} replies from "
                f"{', '.join(sorted(ModelProxy.served_seen))} instead of {ModelProxy.model}; scores are suspect",
                flush=True,
            )

    lain = read_trials(args.jobs_dir, f"{args.job_name}-lain")
    terminus = read_trials(args.jobs_dir, f"{args.job_name}-terminus-2")
    out_path = Path(args.jobs_dir) / f"{args.job_name}-table.md"
    table = write_table(args, tasks, lain, terminus, out_path)
    print(f"\n{table}\nwritten to {out_path}", flush=True)
    if failures:
        print(f"harbor exited non-zero for: {', '.join(failures)} (trials still counted above)", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
