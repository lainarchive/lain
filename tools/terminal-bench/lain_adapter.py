import json
import os
from pathlib import Path
from shlex import join
from tempfile import TemporaryDirectory

from harbor.agents.base import BaseAgent


class LainAgent(BaseAgent):
    @staticmethod
    def name():
        return "lain"

    def version(self):
        return os.environ["LAIN_BENCH_REVISION"]

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
                # No wall clock: harbor already enforces the task's own agent
                # timeout on run(), and Terminus-2 gets the same limit. A
                # second cap here would lose a head to head on time alone.
            },
        }
        with TemporaryDirectory() as folder:
            path = Path(folder) / "lain.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            await environment.upload_file(path, "/tmp/lain-bench.json")
        result = await environment.exec("chmod 700 /tmp/lain-agent && /tmp/lain-agent --help >/dev/null")
        if result.return_code != 0:
            raise RuntimeError(f"Lain setup failed: {result.stderr}")

    async def run(self, instruction, environment, context):
        command = join(["/tmp/lain-agent", "run", "--json", instruction])
        result = await environment.exec(
            command,
            env={
                "LAIN_ALLOW_SHELL": "1",
                "LAIN_CONFIG": "/tmp/lain-bench.json",
                "LAIN_IPC_ENDPOINT": "/tmp/lain-bench.sock",
                "LAIN_MEMORY_DB": "/tmp/lain-bench.db",
                "LAIN_BENCH_ACCESS": os.environ["LAIN_BENCH_ACCESS"],
            },
        )
        (self.logs_dir / "lain-report.json").write_text(result.stdout or "", encoding="utf-8")
        (self.logs_dir / "lain-stderr.txt").write_text(result.stderr or "", encoding="utf-8")
        context.metadata = {"lain_exit_code": result.return_code}
        if result.return_code == 1:
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
