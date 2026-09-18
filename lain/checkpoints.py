"""Inspectable, conservative project checkpoints.

A checkpoint records a known Git commit for a project. It intentionally requires
a clean working tree so restoring to the checkpoint is deterministic.
"""

from __future__ import annotations

import json
import os
import subprocess
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def checkpoint_root() -> Path:
    configured = os.environ.get("LAIN_CHECKPOINTS")
    return Path(configured).expanduser() if configured else Path.home() / ".lain" / "checkpoints"


@dataclass(frozen=True)
class Checkpoint:
    id: str
    project: str
    path: str
    commit: str
    created_at: str = field(default_factory=_now)


def _git(path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=path,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout.strip()


def create_checkpoint(project: str, project_path: str | Path) -> Checkpoint:
    root = Path(project_path).expanduser().resolve()
    if not (root / ".git").exists():
        raise RuntimeError("checkpoints currently require a Git repository")
    status = _git(root, "status", "--porcelain")
    if status:
        raise RuntimeError("checkpoint requires a clean working tree")
    commit = _git(root, "rev-parse", "HEAD")
    item = Checkpoint(uuid.uuid4().hex, project, str(root), commit)
    target = checkpoint_root()
    target.mkdir(parents=True, exist_ok=True)
    (target / f"{item.id}.json").write_text(
        json.dumps(asdict(item), indent=2) + "\n",
        encoding="utf-8",
    )
    return item


def list_checkpoints(*, project: str | None = None, limit: int = 20) -> list[Checkpoint]:
    root = checkpoint_root()
    if not root.exists():
        return []
    items = []
    for path in sorted(root.glob("*.json"), key=lambda p: p.stat().st_mtime):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            item = Checkpoint(**data)
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            continue
        if project is None or item.project == project:
            items.append(item)
    return list(reversed(items[-max(1, limit):]))
