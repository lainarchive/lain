"""Rinnosuke: the development specialist for lain."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Mapping, Sequence

from ..models.llama import ask
from ..tools import describe_tools


@dataclass(frozen=True)
class WorkItem:
    goal: str
    action: str
    verification: str


@dataclass(frozen=True)
class DevelopmentPlan:
    goal: str
    items: tuple[WorkItem, ...]
    files: tuple[str, ...] = ()
    commands: tuple[str, ...] = ()


DEVELOPMENT_SIGNALS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("implementation", ("implement", "add", "create", "build", "write", "make")),
    ("modification", ("change", "update", "edit", "modify", "refactor", "rewrite")),
    ("bugfix", ("fix", "bug", "broken", "error", "crash", "issue")),
    ("testing", ("test", "verify", "check", "validate")),
    ("tooling", ("tool", "cli", "script", "automation", "command")),
)


def classify(task: str) -> tuple[str, ...]:
    """Return the development concerns detected in a task."""
    lowered = task.casefold()
    return tuple(name for name, keywords in DEVELOPMENT_SIGNALS if any(keyword in lowered for keyword in keywords))


def plan(task: str) -> DevelopmentPlan:
    """Create a conservative implementation plan."""
    concerns = classify(task)
    items: list[WorkItem] = [
        WorkItem("Understand the existing implementation", "Inspect relevant files and preserve working behavior.", "Confirm interfaces and constraints before editing."),
        WorkItem("Implement the requested change", "Make the smallest coherent change that satisfies the task.", "Check syntax, interfaces, edge cases, and affected behavior."),
        WorkItem("Verify the result", "Run the narrowest useful tests or checks available.", "Confirm the requested behavior and report anything not verified."),
    ]
    if "bugfix" in concerns:
        items.insert(0, WorkItem("Find the root cause", "Trace the failure to its source instead of patching symptoms.", "Explain why the change addresses the failure."))
    return DevelopmentPlan(task, tuple(items))


def execute(
    task: str,
    *,
    tools: Mapping[str, Callable[..., object]] | None = None,
    context: Sequence[str] = (),
) -> str:
    """Work on a development task with controlled local capabilities."""
    execution_plan = plan(task)
    plan_text = "\n".join(
        f"{index}. {item.goal}: {item.action} Verify: {item.verification}"
        for index, item in enumerate(execution_plan.items, 1)
    )
    context_text = "\n\n".join(context) if context else "No additional project context was supplied."

    prompt = (
        "You are Rinnosuke, the development specialist inside lain.\n"
        "You are not a generic chatbot. You are a careful software engineer.\n\n"
        "AVAILABLE LOCAL TOOLS:\n"
        f"{describe_tools()}\n\n"
        "DEVELOPMENT PROTOCOL:\n"
        "1. Inspect before editing.\n"
        "2. Identify the smallest set of affected files.\n"
        "3. Read relevant code and understand its interfaces.\n"
        "4. Change only what the task requires.\n"
        "5. Never overwrite an existing file blindly.\n"
        "6. Run focused verification after changes.\n"
        "7. Inspect git diff/status before declaring success.\n"
        "8. Never claim a tool ran unless its result was actually returned.\n"
        "9. If a tool refuses an operation, diagnose the refusal instead of bypassing it.\n"
        "10. If evidence is insufficient, say exactly what remains unverified.\n\n"
        "WORK PLAN:\n"
        f"{plan_text}\n\n"
        "PROJECT CONTEXT:\n"
        f"{context_text}\n\n"
        f"USER TASK:\n{task}"
    )

    if tools and "inspect" in tools:
        inspected = tools["inspect"](task)
        context = (*context, str(inspected))
        prompt += f"\n\nINITIAL INSPECTION RESULT:\n{inspected}"

    return ask(prompt)


dispatch = execute
