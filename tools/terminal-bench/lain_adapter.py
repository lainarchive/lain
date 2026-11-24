import asyncio
import json
import os
import tomllib
from pathlib import Path
from shlex import join, quote
from tempfile import TemporaryDirectory

from harbor.agents.base import BaseAgent


class LainAgent(BaseAgent):
    @staticmethod
    def name():
        return "lain"

    def version(self):
        return os.environ["LAIN_BENCH_REVISION"]

    def agent_wall_clock_ms(self):
        # Harbor kills run() at the trial's agent timeout, so a Lain wall clock
        # at or above it never fires and the run dies mid-work with no chance to
        # wrap up. I read the same inputs harbor does — the task's [agent]
        # timeout_sec plus the run's override and multiplier from the trial
        # config.json that already exists beside this logs dir — and leave 60 s
        # for the report and stderr writes to land before the kill.
        try:
            trial = json.loads(
                (self.logs_dir.parent / "config.json").read_text(encoding="utf-8")
            )
            task = tomllib.loads(
                (Path(trial["task"]["path"]) / "task.toml").read_text(encoding="utf-8")
            )
        except (OSError, KeyError, TypeError, json.JSONDecodeError, tomllib.TOMLDecodeError):
            return None
        agent = trial.get("agent") or {}
        base = agent.get("override_timeout_sec") or (task.get("agent") or {}).get("timeout_sec")
        if base is None:
            return None
        resolved = min(base, agent.get("max_timeout_sec") or float("inf"))
        multiplier = trial.get("agent_timeout_multiplier")
        if multiplier is None:
            multiplier = trial.get("timeout_multiplier") or 1.0
        wall_ms = int(resolved * multiplier * 1000) - 60_000
        return wall_ms if wall_ms > 0 else None

    async def setup(self, environment):
        await environment.upload_file(os.environ["LAIN_BENCH_BINARY"], "/tmp/lain-agent")
        config = {
            "provider": {
                "kind": "open_ai_compatible",
                "base_url": os.environ["LAIN_BENCH_PROXY_URL"],
                "api_key_env": "LAIN_BENCH_ACCESS",
            },
            "model": self.model_name,
            "system_prompt": "Use the terminal to complete the user's task. Check your work before replying.",
            "temperature": 0,
            "max_turns": 80,
            "max_consecutive_tool_errors": 3,
            "memory_context_limit": 0,
            "context_window_tokens": 65536,
            "allow_creator_mode": False,
            "budget": {
                "max_completion_tokens": 8192,
                "max_tool_calls": 120,
            },
        }
        if wall_ms := self.agent_wall_clock_ms():
            config["budget"]["max_wall_time_ms"] = wall_ms
        with TemporaryDirectory() as folder:
            path = Path(folder) / "lain.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            await environment.upload_file(path, "/tmp/lain-bench.json")
        result = await environment.exec("chmod 700 /tmp/lain-agent && /tmp/lain-agent --help >/dev/null")
        if result.return_code != 0:
            raise RuntimeError(f"Lain setup failed: {result.stderr}")

    async def run(self, instruction, environment, context):
        # A harbor timeout kill never lets exec return, so anything the run
        # only printed was lost. The agent flushes its report to
        # /tmp/lain-report.json after every event (LAIN_REPORT_PATH) and this
        # now runs detached: the poll loop snapshots that file plus the output
        # logs so the artifacts exist however the trial ends.
        inner = (
            join(["/tmp/lain-agent", "run", "--json", instruction])
            + " >/tmp/lain-stdout.log 2>/tmp/lain-stderr.log; echo $? >/tmp/lain-rc"
        )
        launcher = await environment.exec(
            f"nohup bash -c {quote(inner)} >/dev/null 2>&1 & echo $!",
            env={
                "LAIN_ALLOW_SHELL": "1",
                "LAIN_CONFIG": "/tmp/lain-bench.json",
                "LAIN_IPC_ENDPOINT": "/tmp/lain-bench.sock",
                "LAIN_MEMORY_DB": "/tmp/lain-bench.db",
                "LAIN_BENCH_ACCESS": os.environ["LAIN_BENCH_ACCESS"],
                "LAIN_REPORT_PATH": "/tmp/lain-report.json",
            },
        )
        pid = (launcher.stdout or "").strip()
        if not pid.isdigit():
            raise RuntimeError(f"Lain launch failed: {launcher.stderr or launcher.stdout}")

        async def snapshot():
            for remote, local in (
                ("/tmp/lain-report.json", "lain-report.json"),
                ("/tmp/lain-stderr.log", "lain-stderr.txt"),
            ):
                result = await environment.exec(f"cat {remote} 2>/dev/null")
                if result.return_code == 0 and result.stdout:
                    (self.logs_dir / local).write_text(result.stdout, encoding="utf-8")

        try:
            while True:
                alive = await environment.exec(f"kill -0 {pid} 2>/dev/null")
                if alive.return_code != 0:
                    break
                await snapshot()
                await asyncio.sleep(10)
        finally:
            for remote, local in (
                ("/tmp/lain-report.json", "lain-report.json"),
                ("/tmp/lain-stderr.log", "lain-stderr.txt"),
                ("/tmp/lain-stdout.log", "lain-stdout.txt"),
            ):
                try:
                    result = await environment.exec(f"cat {remote} 2>/dev/null")
                except Exception:
                    continue
                if result.return_code == 0 and result.stdout:
                    (self.logs_dir / local).write_text(result.stdout, encoding="utf-8")
        context.metadata = {"lain_exit_code": None}
        for _ in range(20):
            done = await environment.exec("cat /tmp/lain-rc 2>/dev/null")
            if done.return_code == 0 and done.stdout.strip().isdigit():
                context.metadata["lain_exit_code"] = int(done.stdout.strip())
                break
            await asyncio.sleep(0.5)
        if context.metadata["lain_exit_code"] == 1:
            script = """
import json, sqlite3
with sqlite3.connect('file:/tmp/lain-bench.db?mode=ro', uri=True) as db:
    rows = db.execute("SELECT content FROM memories WHERE title LIKE '%tool %' ORDER BY id")
    for (content,) in rows:
        entry = json.loads(content)
        outcome = entry["outcome"]
        if outcome["outcome"] != "succeeded" or outcome.get("exit_code"):
            print(json.dumps(entry))
"""
            trace = await environment.exec(join(["python3", "-c", script]))
            if trace.return_code == 0:
                (self.logs_dir / "lain-failed-tools.jsonl").write_text(trace.stdout or "", encoding="utf-8")
