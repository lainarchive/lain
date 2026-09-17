"""Rinnosuke: the development specialist for lain.

Rinnosuke is deliberately tool-agnostic. He understands software tasks,
produces implementation plans, and can execute through injected tools when
lain gains controlled file and command capabilities.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Mapping, Sequence

from ..models.llama import ask


@dataclass(frozen=True)
class WorkItem:
    """A concrete unit of development work."""

    goal: str
    action: str
    verification: str


@dataclass(frozen=True)
class DevelopmentPlan:
    """A structured plan Rinnosuke can execute or hand to another worker."""

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
    return tuple(
        name
        for name, keywords in DEVELOPMENT_SIGNALS
        if any(keyword in lowered for keyword in keywords)
    )


def plan(task: str) -> DevelopmentPlan:
    """Create a conservative implementation plan from a development task."""
    concerns = classify(task)
    items: list[WorkItem] = [
        WorkItem(
            "Understand the existing implementation",
            "Inspect the relevant files and preserve working behavior.",
            "Confirm the existing interfaces and constraints before editing.",
        ),
        WorkItem(
            "Implement the requested change",
            "Make the smallest coherent change that satisfies the task.",
            "Check syntax, imports, interfaces, and obvious edge cases.",
        ),
        WorkItem(
            "Verify the result",
            "Run the narrowest useful tests or checks available.",
            "Confirm the requested behavior and report anything that could not be verified.",
        ),
    ]

    if "bugfix" in concerns:
        items.insert(
            0,
            WorkItem(
                "Find the root cause",
                "Trace the failure to its source instead of patching symptoms.",
                "Explain why the proposed change addresses the failure.",
            ),
        )

    return DevelopmentPlan(task, tuple(items))


def execute(
    task: str,
    *,
    tools: Mapping[str, Callable[..., str]] | None = None,
    context: Sequence[str] = (),
) -> str:
    """Execute a development task through injected tools or the local model.

    Tools are intentionally injected rather than discovered globally. This keeps
    file writes and command execution explicit, testable, and easy to sandbox.
    """
    execution_plan = plan(task)

    if tools:
        inspect = tools.get("inspect")
        if inspect:
            inspected = inspect(task)
            context = (*context, inspected)

    plan_text = "\n".join(
        f"{index}. {item.goal}: {item.action} Verify: {item.verification}"
        for index, item in enumerate(execution_plan.items, 1)
    )
    context_text = "\n\n".join(context) if context else "No additional project context was supplied."

    prompt = (
        "You are Rinnosuke, the development specialist inside lain.\n"
        "Your job is to solve software engineering tasks carefully and concretely.\n\n"
        "DEVELOPMENT PRINCIPLES:\n"
        "- Inspect before changing.\n"
        "- Preserve existing behavior unless the task requires otherwise.\n"
        "- Prefer small, coherent changes over broad rewrites.\n"
        "- Never invent repository contents, APIs, test results, or tool output.\n"
        "- Separate what you know from what you infer.\n"
        "- Verify changes whenever verification is available.\n"
        "- If execution tools are unavailable, provide the exact implementation needed without pretending it was applied.\n\n"
        "WORK PLAN:\n"
        f"{plan_text}\n\n"
        "PROJECT CONTEXT:\n"
        f"{context_text}\n\n"
        f"USER TASK:\n{task}"
    )

    return ask(prompt)


# Public alias used by future orchestration code.
dispatch = execute
