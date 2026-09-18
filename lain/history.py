"""Persistent decision and event history for lain.

History is append-only JSONL so it stays inspectable, portable, and cheap.
Decisions describe durable choices; events describe useful things that happened.
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def history_path() -> Path:
    configured = os.environ.get("LAIN_HISTORY")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".lain" / "history.jsonl"


@dataclass
class Decision:
    project: str
    decision: str
    reason: str
    affected_systems: list[str] = field(default_factory=list)
    active: bool = True
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    created_at: str = field(default_factory=_now)


@dataclass
class Event:
    kind: str
    summary: str
    project: str | None = None
    details: dict = field(default_factory=dict)
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    created_at: str = field(default_factory=_now)


def _append(record: object) -> None:
    path = history_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"type": type(record).__name__.lower(), **asdict(record)}
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def record_decision(project: str, decision: str, reason: str, affected_systems: list[str] | None = None) -> Decision:
    item = Decision(project, decision, reason, affected_systems or [])
    _append(item)
    return item


def record_event(kind: str, summary: str, project: str | None = None, details: dict | None = None) -> Event:
    item = Event(kind, summary, project, details or {})
    _append(item)
    return item


def recent_history(limit: int = 20, *, project: str | None = None, record_type: str | None = None) -> list[dict]:
    path = history_path()
    if not path.exists():
        return []
    records: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if project is not None and item.get("project") != project:
            continue
        if record_type is not None and item.get("type") != record_type:
            continue
        records.append(item)
    return records[-max(0, limit):]
