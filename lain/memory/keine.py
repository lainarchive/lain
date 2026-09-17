"""Keine: persistent, inspectable memory for lain."""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

DEFAULT_MEMORY_FILE = Path.home() / ".lain" / "memory.jsonl"


@dataclass(frozen=True)
class Memory:
    id: str
    content: str
    kind: str = "note"
    scope: str = "global"
    tags: tuple[str, ...] = ()
    created_at: str = ""


def _path() -> Path:
    return Path(os.environ.get("LAIN_MEMORY_FILE", DEFAULT_MEMORY_FILE))


def _ensure_store() -> Path:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(exist_ok=True)
    return path


def remember(content: str, *, kind: str = "note", scope: str = "global", tags: tuple[str, ...] = ()) -> Memory:
    """Persist one memory as an append-only JSONL record."""
    content = content.strip()
    if not content:
        raise ValueError("memory content cannot be empty")

    memory = Memory(
        id=uuid4().hex,
        content=content,
        kind=kind.strip() or "note",
        scope=scope.strip() or "global",
        tags=tuple(tag.strip().casefold() for tag in tags if tag.strip()),
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    with _ensure_store().open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(asdict(memory), ensure_ascii=False) + "\n")
    return memory


def _load() -> list[Memory]:
    path = _ensure_store()
    memories: list[Memory] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                data = json.loads(line)
                memories.append(
                    Memory(
                        id=str(data["id"]),
                        content=str(data["content"]),
                        kind=str(data.get("kind", "note")),
                        scope=str(data.get("scope", "global")),
                        tags=tuple(str(tag) for tag in data.get("tags", [])),
                        created_at=str(data.get("created_at", "")),
                    )
                )
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                continue
    return memories


def search(query: str, *, scope: str | None = None, limit: int = 8) -> list[Memory]:
    """Return the most relevant memories using simple local lexical scoring."""
    terms = tuple(dict.fromkeys(re.findall(r"[a-z0-9_'-]+", query.casefold())))
    if not terms:
        return []

    scored: list[tuple[int, int, Memory]] = []
    for index, memory in enumerate(_load()):
        if scope and memory.scope not in {"global", scope}:
            continue
        haystack = " ".join((memory.content.casefold(), memory.kind.casefold(), memory.scope.casefold(), *memory.tags))
        score = sum(haystack.count(term) for term in terms)
        if score:
            scored.append((score, index, memory))

    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [memory for _, _, memory in scored[: max(1, limit)]]


def recent(*, scope: str | None = None, limit: int = 8) -> list[Memory]:
    """Return recent memories without requiring a search query."""
    memories = [m for m in _load() if not scope or m.scope in {"global", scope}]
    return list(reversed(memories[-max(1, limit):]))


def context(query: str, *, scope: str | None = None, limit: int = 8) -> str:
    """Format relevant memory for injection into an agent prompt."""
    memories = search(query, scope=scope, limit=limit)
    if not memories:
        return "No relevant stored memory."
    return "\n".join(
        f"- [{memory.kind}] {memory.content}"
        + (f" (tags: {', '.join(memory.tags)})" if memory.tags else "")
        for memory in memories
    )
