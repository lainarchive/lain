"""Controlled local development tools for lain.

The tools are intentionally boring and strict. Rinnosuke gets useful machine
capabilities without receiving an unrestricted, shell-shaped hole in the
system.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from ..constitution import can_modify, load_constitution

DEFAULT_WORKSPACE = Path.cwd()
MAX_READ_BYTES = 512_000
MAX_WRITE_BYTES = 512_000
MAX_OUTPUT_CHARS = 40_000
DEFAULT_TIMEOUT = 30
MAX_TIMEOUT = 120


class ToolError(RuntimeError):
    """Raised when a local tool refuses or cannot complete an operation."""


@dataclass(frozen=True)
class ToolResult:
    tool: str
    ok: bool
    output: str


def _workspace() -> Path:
    configured = os.environ.get("LAIN_WORKSPACE")
    return Path(configured).expanduser().resolve() if configured else DEFAULT_WORKSPACE.resolve()


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _resolve(relative_path: str, *, must_exist: bool = False) -> Path:
    if not relative_path or Path(relative_path).is_absolute():
        raise ToolError("path must be a non-empty workspace-relative path")

    root = _workspace()
    candidate = (root / relative_path).resolve()
    if not _inside(candidate, root):
        raise ToolError("path escapes the configured workspace")
    if must_exist and not candidate.exists():
        raise ToolError(f"path does not exist: {relative_path}")
    return candidate


def _clip(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[:MAX_OUTPUT_CHARS] + "\n...[output truncated]"


def read_file(path: str, *, start_line: int | None = None, end_line: int | None = None) -> ToolResult:
    """Read a UTF-8 text file inside the workspace."""
    target = _resolve(path, must_exist=True)
    if not target.is_file():
        raise ToolError(f"not a file: {path}")
    if target.stat().st_size > MAX_READ_BYTES:
        raise ToolError(f"file is larger than the read limit ({MAX_READ_BYTES} bytes): {path}")

    text = target.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    first = max(1, start_line or 1)
    last = min(len(lines), end_line or len(lines))
    if first > last:
        return ToolResult("read_file", True, "")
    numbered = "\n".join(f"{number}: {lines[number - 1]}" for number in range(first, last + 1))
    return ToolResult("read_file", True, numbered)


def list_directory(path: str = ".", *, recursive: bool = False, limit: int = 300) -> ToolResult:
    """List files/directories without following symlinks outside the workspace."""
    target = _resolve(path, must_exist=True)
    if not target.is_dir():
        raise ToolError(f"not a directory: {path}")
    if not 1 <= limit <= 1000:
        raise ToolError("limit must be between 1 and 1000")

    root = _workspace()
    entries: list[str] = []
    iterator = target.rglob("*") if recursive else target.iterdir()
    for entry in sorted(iterator, key=lambda item: str(item).casefold()):
        try:
            resolved = entry.resolve()
        except OSError:
            continue
        if not _inside(resolved, root):
            continue
        rel = resolved.relative_to(root).as_posix()
        marker = "/" if entry.is_dir() else ""
        entries.append(f"{rel}{marker}")
        if len(entries) >= limit:
            break

    return ToolResult("list_directory", True, "\n".join(entries) or "(empty)")


def write_file(path: str, content: str, *, overwrite: bool = False) -> ToolResult:
    """Atomically write a UTF-8 text file inside the workspace."""
    if len(content.encode("utf-8")) > MAX_WRITE_BYTES:
        raise ToolError(f"content exceeds the write limit ({MAX_WRITE_BYTES} bytes)")

    target = _resolve(path)
    constitution = load_constitution(_workspace())
    relative = target.relative_to(_workspace()).as_posix()
    allowed, reason = can_modify(constitution, [relative])
    if not allowed:
        raise ToolError(reason)
    if target.exists() and not overwrite:
        raise ToolError(f"refusing to overwrite existing file without overwrite=True: {path}")
    if target.exists() and not target.is_file():
        raise ToolError(f"target is not a file: {path}")

    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.lain-tmp")
    temporary.write_text(content, encoding="utf-8", newline="")
    temporary.replace(target)
    return ToolResult("write_file", True, f"wrote {path}")


def run_command(argv: Sequence[str], *, timeout: int = DEFAULT_TIMEOUT) -> ToolResult:
    """Run an executable without a shell, inside the workspace."""
    args = [str(part) for part in argv]
    if not args or not args[0].strip():
        raise ToolError("command cannot be empty")
    if not 1 <= timeout <= MAX_TIMEOUT:
        raise ToolError(f"timeout must be between 1 and {MAX_TIMEOUT} seconds")

    blocked = {"format", "diskpart", "shutdown", "reagentc", "cipher"}
    executable = Path(args[0]).name.casefold()
    if executable in blocked:
        raise ToolError(f"refusing high-impact command: {args[0]}")

    try:
        result = subprocess.run(
            args,
            cwd=_workspace(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=False,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ToolError(f"executable not found: {args[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        output = _clip((exc.stdout or "") + ("\n" + exc.stderr if exc.stderr else ""))
        return ToolResult("run_command", False, f"command timed out after {timeout}s\n{output}")

    output = _clip(result.stdout.strip())
    if result.stderr.strip():
        output = f"{output}\n[stderr]\n{_clip(result.stderr.strip())}" if output else f"[stderr]\n{_clip(result.stderr.strip())}"
    return ToolResult("run_command", result.returncode == 0, output or f"exit code {result.returncode}")


def run_test(argv: Sequence[str] | None = None, *, timeout: int = DEFAULT_TIMEOUT) -> ToolResult:
    """Run an explicitly supplied test command, defaulting to Python unittest discovery."""
    command = list(argv) if argv else [os.environ.get("PYTHON", "python"), "-m", "unittest", "discover"]
    result = run_command(command, timeout=timeout)
    return ToolResult("run_test", result.ok, result.output)


def git_status() -> ToolResult:
    """Return repository status in porcelain form."""
    return run_command(["git", "status", "--short", "--branch"])


def git_diff() -> ToolResult:
    """Return the current unstaged diff."""
    return run_command(["git", "diff", "--"])


TOOLS = {
    "read_file": read_file,
    "list_directory": list_directory,
    "write_file": write_file,
    "run_command": run_command,
    "run_test": run_test,
    "git_status": git_status,
    "git_diff": git_diff,
}


def describe_tools() -> str:
    """Return the tool contract exposed to an agent."""
    return (
        "read_file(path, start_line?, end_line?) — inspect UTF-8 text.\n"
        "list_directory(path='.', recursive?, limit?) — inspect workspace structure.\n"
        "write_file(path, content, overwrite=False) — atomically write text; existing files require explicit overwrite.\n"
        "run_command(argv, timeout=30) — execute one non-shell command in the workspace.\n"
        "run_test(argv?, timeout=30) — run an explicit test command or Python unittest discovery.\n"
        "git_status() — inspect repository state.\n"
        "git_diff() — inspect unstaged changes."
    )
