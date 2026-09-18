"""Project constitutions for lain.

A constitution is an explicit, inspectable set of rules for a project.
It is deliberately data-oriented: the runtime can enforce boundaries without
asking a model to remember them.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class Constitution:
    project: str
    locked: list[str] = field(default_factory=list)
    allowed: list[str] = field(default_factory=list)
    verification: list[str] = field(default_factory=list)
    constraints: list[str] = field(default_factory=list)


def constitution_path(project_path: str | Path) -> Path:
    return Path(project_path).expanduser().resolve() / ".lain" / "constitution.json"


def load_constitution(project_path: str | Path, project_name: str | None = None) -> Constitution:
    path = constitution_path(project_path)
    if not path.exists():
        return Constitution(project_name or Path(project_path).name)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return Constitution(project_name or Path(project_path).name)
    return Constitution(
        project=str(raw.get("project", project_name or Path(project_path).name)),
        locked=[str(x) for x in raw.get("locked", [])],
        allowed=[str(x) for x in raw.get("allowed", [])],
        verification=[str(x) for x in raw.get("verification", [])],
        constraints=[str(x) for x in raw.get("constraints", [])],
    )


def save_constitution(project_path: str | Path, constitution: Constitution) -> Path:
    path = constitution_path(project_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(constitution), indent=2) + "\n", encoding="utf-8")
    return path


def path_matches_rule(path: str, rule: str) -> bool:
    candidate = Path(path).as_posix().casefold().strip("/")
    pattern = rule.replace("\\", "/").casefold().strip("/")
    if not pattern:
        return False
    if candidate == pattern or candidate.startswith(pattern + "/"):
        return True
    return Path(candidate).match(pattern)


def locked_paths(constitution: Constitution) -> tuple[str, ...]:
    return tuple(constitution.locked)


def can_modify(constitution: Constitution, paths: list[str]) -> tuple[bool, str]:
    for path in paths:
        if any(path_matches_rule(path, rule) for rule in constitution.locked):
            return False, f"constitution locks path: {path}"
    return True, "allowed"
