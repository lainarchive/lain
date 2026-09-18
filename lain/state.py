"""Persistent operating state for lain.

This module stores explicit runtime state separately from project discovery and memory.
It is intentionally small and JSON-backed so the state remains inspectable and portable.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

MODES = ("OBSERVE", "ASSIST", "EXECUTE")
PROJECT_STATES = ("active", "paused", "archived", "experimental")


def state_path() -> Path:
    configured = os.environ.get("LAIN_STATE")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".lain" / "state.json"


@dataclass
class Mission:
    objective: str
    project: str | None = None
    phase: str = "planning"
    constraints: list[str] = field(default_factory=list)
    completed: list[str] = field(default_factory=list)
    pending: list[str] = field(default_factory=list)
    verification: str = "pending"
    updated_at: str = field(default_factory=lambda: _now())


@dataclass
class OperatingState:
    active_project: str | None = None
    mode: str = "ASSIST"
    project_states: dict[str, str] = field(default_factory=dict)
    mission: Mission | None = None
    last_summary: str | None = None
    updated_at: str = field(default_factory=lambda: _now())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_state() -> OperatingState:
    path = state_path()
    if not path.exists():
        return OperatingState()

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return OperatingState()

    mission_raw = raw.get("mission")
    mission = Mission(**mission_raw) if isinstance(mission_raw, dict) else None
    mode = raw.get("mode", "ASSIST")
    if mode not in MODES:
        mode = "ASSIST"

    project_states = {
        str(name): value
        for name, value in raw.get("project_states", {}).items()
        if value in PROJECT_STATES
    }
    return OperatingState(
        active_project=raw.get("active_project"),
        mode=mode,
        project_states=project_states,
        mission=mission,
        last_summary=raw.get("last_summary"),
        updated_at=raw.get("updated_at", _now()),
    )


def save_state(state: OperatingState) -> Path:
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    state.updated_at = _now()
    path.write_text(
        json.dumps(asdict(state), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return path


def set_mode(mode: str) -> OperatingState:
    mode = mode.upper()
    if mode not in MODES:
        raise ValueError(f"invalid mode: {mode}; choose OBSERVE, ASSIST, or EXECUTE")
    state = load_state()
    state.mode = mode
    save_state(state)
    return state


def set_active_project(name: str | None) -> OperatingState:
    state = load_state()
    state.active_project = name
    if name and name not in state.project_states:
        state.project_states[name] = "active"
    save_state(state)
    return state


def set_project_state(name: str, project_state: str) -> OperatingState:
    project_state = project_state.lower()
    if project_state not in PROJECT_STATES:
        raise ValueError(
            f"invalid project state: {project_state}; choose "
            "active, paused, archived, or experimental"
        )
    state = load_state()
    state.project_states[name] = project_state
    save_state(state)
    return state


def start_mission(
    objective: str,
    *,
    project: str | None = None,
    phase: str = "planning",
    constraints: list[str] | None = None,
) -> OperatingState:
    state = load_state()
    state.mission = Mission(
        objective=objective,
        project=project or state.active_project,
        phase=phase,
        constraints=constraints or [],
    )
    save_state(state)
    return state


def update_mission(
    *,
    phase: str | None = None,
    completed: list[str] | None = None,
    pending: list[str] | None = None,
    verification: str | None = None,
    summary: str | None = None,
) -> OperatingState:
    """Update explicit mission progress without guessing what has been done."""
    state = load_state()
    if state.mission is None:
        raise ValueError("no active mission")
    if phase is not None:
        state.mission.phase = phase
    if completed is not None:
        state.mission.completed = completed
    if pending is not None:
        state.mission.pending = pending
    if verification is not None:
        state.mission.verification = verification
    if summary is not None:
        state.last_summary = summary
    state.mission.updated_at = _now()
    save_state(state)
    return state


def clear_mission() -> OperatingState:
    state = load_state()
    state.mission = None
    save_state(state)
    return state


def operating_picture() -> dict:
    state = load_state()
    mission = asdict(state.mission) if state.mission else None
    return {
        "active_project": state.active_project,
        "mode": state.mode,
        "project_states": state.project_states,
        "mission": mission,
        "last_summary": state.last_summary,
        "updated_at": state.updated_at,
    }
