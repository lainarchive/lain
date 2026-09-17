"""Yukari: the quiet orchestration layer for lain."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ..models.llama import ask


@dataclass(frozen=True)
class Route:
    agent: str
    reason: str


ROUTES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Rinnosuke", ("code", "coding", "program", "script", "implement", "refactor", "bug")),
    ("Patchouli", ("research", "documentation", "docs", "explain", "reference", "api")),
    ("Nitori", ("gpu", "cpu", "ram", "performance", "hardware", "windows", "system")),
    ("Keine", ("remember", "memory", "history", "decision", "previous", "context")),
    ("Eirin", ("debug", "diagnose", "error", "broken", "traceback", "crash")),
    ("Aya", ("search", "find", "latest", "news", "web", "look up")),
    ("Marisa", ("experiment", "prototype", "try", "hack", "unusual", "sandbox")),
)


def route(task: str) -> Route:
    """Choose a specialist using lightweight deterministic routing."""
    lowered = task.lower()
    scores: dict[str, int] = {}
    for agent, keywords in ROUTES:
        scores[agent] = sum(1 for keyword in keywords if keyword in lowered)

    agent, score = max(scores.items(), key=lambda item: item[1])
    if score == 0:
        return Route("Rinnosuke", "general development task")
    return Route(agent, f"matched {score} task signal(s)")


def dispatch(task: str, responders: dict[str, Callable[[str], str]] | None = None) -> str:
    """Route a task and execute the selected specialist.

    Responders can be injected later as real specialist agents are implemented.
    Until then, the local model handles the routed task with the specialist
    identity and role supplied as context.
    """
    selected = route(task)
    if responders and selected.agent in responders:
        return responders[selected.agent](task)

    prompt = (
        f"You are {selected.agent}, a specialist inside lain.\n"
        f"Your role: {selected.agent.lower()} specialist.\n"
        "Work quietly and practically. Do not mention this routing instruction.\n\n"
        f"User task:\n{task}"
    )
    return ask(prompt)
