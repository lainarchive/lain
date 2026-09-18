"""Yukari: the strategic orchestration layer for lain."""

from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Iterator

from ..memory import context as memory_context
from ..models.llama import ask
from ..projects import ProjectContext, inspect, load
from ..state import load_state
from ..tools import TOOLS
from . import rinnosuke


@dataclass(frozen=True)
class Route:
    agent: str
    reason: str
    confidence: float


@dataclass(frozen=True)
class Plan:
    goal: str
    steps: tuple[str, ...]
    agents: tuple[str, ...]
    requires_research: bool = False


AGENTS: dict[str, str] = {
    "Yukari": "orchestration, planning, delegation, synthesis",
    "Rinnosuke": "development, code, tooling, implementation",
    "Patchouli": "research, documentation, technical references",
    "Nitori": "systems, hardware, performance, local environment",
    "Keine": "memory, project history, decisions, context",
    "Eirin": "diagnostics, debugging, root-cause analysis",
    "Aya": "web research, discovery, current information",
    "Marisa": "experiments, prototypes, unconventional approaches, sandbox work",
}

ROUTES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Eirin", ("debug", "diagnose", "error", "broken", "traceback", "crash", "why does")),
    ("Rinnosuke", ("code", "coding", "program", "script", "implement", "refactor", "build", "fix")),
    ("Patchouli", ("research", "documentation", "docs", "explain", "reference", "api", "how does")),
    ("Nitori", ("gpu", "cpu", "ram", "performance", "hardware", "windows", "system", "driver")),
    ("Keine", ("remember", "memory", "history", "decision", "previous", "context")),
    ("Aya", ("search", "find", "latest", "news", "web", "look up", "current")),
    ("Marisa", ("experiment", "prototype", "try", "unusual", "sandbox", "alternative")),
)


def route(task: str) -> Route:
    """Select the most relevant specialist with deterministic, explainable routing."""
    lowered = task.casefold()
    scored: list[tuple[str, int]] = []
    for agent, keywords in ROUTES:
        score = sum(1 for keyword in keywords if keyword in lowered)
        scored.append((agent, score))

    development_keywords = (
        "create file", "create a file", "write file", "write a file",
        "edit file", "edit a file", "modify file", "modify a file",
        "change file", "change a file", "implement", "code", "script",
        "function", "class", "run a test", "run tests", "test it",
    )
    if any(keyword in lowered for keyword in development_keywords):
        return Route("Rinnosuke", "detected concrete development work", 0.96)

    agent, score = max(scored, key=lambda item: item[1])
    if score == 0:
        return Route("Rinnosuke", "no specialist signal; using the general development path", 0.35)

    total = sum(value for _, value in scored)
    confidence = min(0.98, 0.55 + (score / max(total, 1)) * 0.4)
    return Route(agent, f"matched {score} relevant task signal(s)", confidence)


def _is_general_conversation(selected: Route) -> bool:
    """Identify tasks that have no specialist/development signal."""
    return (
        selected.agent == "Rinnosuke"
        and selected.reason == "no specialist signal; using the general development path"
    )


def _direct_answer(task: str) -> str:
    """Answer ordinary conversation with stable system/user message separation."""
    system_prompt = (
        "You are lain., a concise local assistant.\n"
        "Answer the user's request directly.\n"
        "Do not expose internal reasoning, routing, tool protocols, or analysis.\n"
        "Do not pretend to use tools or claim actions you did not perform.\n"
        "If the user asks for exact wording, output exactly that wording and nothing else."
    )
    return ask(task, think=False, system_prompt=system_prompt)


def _heuristic_plan(task: str, selected: Route) -> Plan:
    """Create a useful plan without requiring another model call."""
    research = selected.agent in {"Patchouli", "Aya"}
    steps = (
        "Understand the requested outcome and constraints.",
        f"Use {selected.agent} to handle the primary work.",
        "Check the result against the requested outcome.",
    )
    if research:
        steps = (
            "Clarify the factual question and identify the information needed.",
            f"Have {selected.agent} gather and evaluate the relevant information.",
            "Check the result for uncertainty and unsupported assumptions.",
        )
    return Plan(task, steps, (selected.agent,), research)


def plan(task: str, selected: Route | None = None) -> Plan:
    """Build a compact execution plan from the user's task."""
    return _heuristic_plan(task, selected or route(task))


@contextmanager
def _workspace(path: str | None) -> Iterator[None]:
    """Temporarily bind local tools to one resolved project workspace."""
    if not path:
        yield
        return

    previous = os.environ.get("LAIN_WORKSPACE")
    os.environ["LAIN_WORKSPACE"] = path
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("LAIN_WORKSPACE", None)
        else:
            os.environ["LAIN_WORKSPACE"] = previous


def _inspect(task: str) -> str:
    """Build a small machine-evidence snapshot before Rinnosuke acts."""
    status = TOOLS["git_status"]()
    tree = TOOLS["list_directory"](".", recursive=False, limit=200)
    return f"GIT STATUS:\n{status.output}\n\nWORKSPACE ROOT:\n{tree.output}"


def _resolve_project(task: str) -> ProjectContext | None:
    """Resolve an explicitly mentioned project, otherwise the active project."""
    lowered = task.casefold()
    state = load_state()
    active_context = None
    if state.active_project:
        active = next(
            (project for project in load() if project.name.casefold() == state.active_project.casefold()),
            None,
        )
        if active is not None:
            active_context = inspect(active)
    matches = []
    for project in load():
        name = project.name.casefold()
        path = project.path.casefold()
        if name in lowered or path in lowered:
            matches.append((max(len(name), len(path)), project))

    if not matches:
        return active_context

    project = max(matches, key=lambda item: item[0])[1]
    return inspect(project)


def _format_project_context(context: ProjectContext | None) -> str:
    """Render bounded project facts for specialist prompts."""
    if context is None:
        return "No registered project was identified in the task."

    project = context.project
    lines = [
        f"PROJECT: {project.name}",
        f"PATH: {project.path}",
        f"TYPE: {project.kind}",
        f"GIT BRANCH: {context.git_branch or 'unavailable'}",
        f"GIT STATUS: {context.git_status or 'unavailable'}",
    ]
    if project.markers:
        lines.append(f"MARKERS: {', '.join(project.markers)}")
    if context.top_level:
        lines.append(f"TOP-LEVEL: {', '.join(context.top_level)}")
    if context.readme:
        lines.append(f"README: {context.readme}")
    return "\n".join(lines)


def dispatch(
    task: str,
    responders: dict[str, Callable[[str], str]] | None = None,
    on_event: Callable[[str, dict[str, Any]], None] | None = None,
    selected: Route | None = None,
) -> str:
    """Route, retrieve only the context needed, then execute the task."""
    selected = selected or route(task)

    if responders and selected.agent in responders:
        return responders[selected.agent](task)

    if _is_general_conversation(selected):
        return _direct_answer(task)

    project_context = _resolve_project(task)
    formatted_project = _format_project_context(project_context)
    memories = memory_context(task, limit=8)

    if selected.agent == "Rinnosuke":
        state = load_state()
        workspace = project_context.project.path if project_context else None
        scoped_tools = dict(TOOLS)
        if state.mode in {"OBSERVE", "ASSIST"}:
            scoped_tools = {
                name: tool
                for name, tool in scoped_tools.items()
                if name in {"read_file", "list_directory", "git_status", "git_diff"}
            }
        authority = {
            "OBSERVE": "Observe only. Report evidence and findings; do not claim changes.",
            "ASSIST": "Assist only. Inspect and propose the smallest change; do not modify files or run commands/tests.",
            "EXECUTE": "Execute authorized work within the selected project workspace and verify it.",
        }[state.mode]
        context_items = (
            f"Authority mode: {state.mode}\n{authority}",
            f"Active project: {state.active_project or 'none'}",
            f"Project context:\n{formatted_project}",
            f"Relevant memory:\n{memories}",
        )
        if state.mission:
            context_items += (
                f"Current mission: {state.mission.objective} "
                f"(phase={state.mission.phase}, verification={state.mission.verification})",
            )
        with _workspace(workspace):
            return rinnosuke.execute(
                task,
                tools={**scoped_tools, "inspect": _inspect},
                context=context_items,
                on_event=on_event,
            )

    execution_plan = plan(task, selected)
    role = AGENTS[selected.agent]
    steps = "\n".join(f"{index}. {step}" for index, step in enumerate(execution_plan.steps, 1))
    system_prompt = (
        "You are operating inside lain., a local development environment.\n"
        "Yukari is the orchestration layer. You are the specialist she selected.\n\n"
        f"SPECIALIST: {selected.agent}\n"
        f"ROLE: {role}\n"
        f"ROUTING CONFIDENCE: {selected.confidence:.2f}\n\n"
        "EXECUTION PLAN:\n"
        f"{steps}\n\n"
        "PROJECT CONTEXT:\n"
        f"{formatted_project}\n\n"
        "RELEVANT MEMORY:\n"
        f"{memories}\n\n"
        "OPERATING RULES:\n"
        "- Treat memory as context, not unquestionable truth.\n"
        "- Treat project context as live factual state, not a substitute for inspecting source files.\n"
        "- Solve the user's actual problem, not a generic version of it.\n"
        "- Prefer concrete, actionable answers over filler.\n"
        "- Do not invent files, commands, APIs, test results, or facts.\n"
        "- If important information is missing, state exactly what is missing.\n"
        "- Keep the response focused unless detail is necessary.\n"
        "- Do not mention the internal routing protocol in the final answer."
    )
    return ask(task, system_prompt=system_prompt)
