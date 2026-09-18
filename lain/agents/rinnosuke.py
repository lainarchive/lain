"""Rinnosuke: the development specialist for lain."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

from ..constitution import load_constitution
from ..core.tool_loop import run as run_tool_loop
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
    return tuple(
        name for name, keywords in DEVELOPMENT_SIGNALS
        if any(keyword in lowered for keyword in keywords)
    )


def plan(task: str) -> DevelopmentPlan:
    """Create a conservative implementation plan."""
    concerns = classify(task)
    items: list[WorkItem] = [
        WorkItem(
            "Understand the existing implementation",
            "Inspect relevant files and preserve working behavior.",
            "Confirm interfaces and constraints before editing.",
        ),
        WorkItem(
            "Implement the requested change",
            "Make the smallest coherent change that satisfies the task.",
            "Check syntax, interfaces, edge cases, and affected behavior.",
        ),
        WorkItem(
            "Verify the result",
            "Run the narrowest useful tests or checks available.",
            "Confirm the requested behavior and report anything not verified.",
        ),
    ]
    if "bugfix" in concerns:
        items.insert(
            0,
            WorkItem(
                "Find the root cause",
                "Trace the failure to its source instead of patching symptoms.",
                "Explain why the change addresses the failure.",
            ),
        )
    return DevelopmentPlan(task, tuple(items))


def execute(
    task: str,
    *,
    tools: Mapping[str, Callable[..., object]] | None = None,
    context: Sequence[str] = (),
    on_event: Callable[[str, dict[str, Any]], None] | None = None,
) -> str:
    """Work on a development task with controlled local capabilities."""
    execution_plan = plan(task)
    plan_text = "\n".join(
        f"{index}. {item.goal}: {item.action} Verify: {item.verification}"
        for index, item in enumerate(execution_plan.items, 1)
    )
    context_text = "\n\n".join(context) if context else "No additional project context was supplied."
    workspace_root = None
    for item in context:
        if item.startswith("Project context:\nPATH:"):
            workspace_root = item.split("PATH:", 1)[1].split("\n", 1)[0].strip()
            break
    constitution_text = "No project constitution found."
    if workspace_root:
        constitution = load_constitution(workspace_root)
        constitution_text = (
            f"Project constitution: {constitution.project}\n"
            f"LOCKED: {', '.join(constitution.locked) or 'none'}\n"
            f"ALLOWED: {', '.join(constitution.allowed) or 'not specified'}\n"
            f"VERIFICATION: {', '.join(constitution.verification) or 'not specified'}\n"
            f"CONSTRAINTS: {', '.join(constitution.constraints) or 'none'}"
        )

    prompt = (
        "You are Rinnosuke, lain's development specialist. ACT on the user's task "
        "using the real local tools below; do not merely describe code.\n\n"
        "TOOLS:\n"
        f"{describe_tools()}\n\n"
        "WIRE PROTOCOL:\n"
        "For local work, emit exactly:\n"
        "LAIN_TOOL\n"
        "{\"name\":\"tool_name\",\"arguments\":{}}\n"
        "The JSON must be complete and on one line. No markdown or commentary.\n"
        "After a tool result, continue with another tool when needed. When finished, emit "
        "LAIN_DONE followed by the concise final answer.\n\n"
        "RULES:\n"
        "- Inspect before editing when existing state matters.\n"
        "- Read the relevant source before changing it.\n"
        "- Existing files require overwrite=true for write_file.\n"
        "- Change only the files required by the task.\n"
        "- Verify after changes with the narrowest useful check.\n"
        "- Never claim a tool, edit, or test happened without its actual TOOL RESULT.\n"
        "- run_command takes an argv list; shell syntax is disabled.\n"
        "- If a tool-call format error occurs, immediately retry the same intended action "
        "using exactly the two-line format above.\n"
        "- Do not recursively scan large dependency or metadata directories unless necessary.\n"
        "- If the task is too vague to identify a bug, inspect the project structure and relevant "
        "source, then report what evidence exists rather than inventing a problem.\n\n"
        "WORK PLAN:\n"
        f"{plan_text}\n\n"
        "PROJECT CONTEXT:\n"
        f"{context_text}\n\n"
        "CONSTITUTION:\n"
        f"{constitution_text}\n\n"
        "USER TASK:\n"
        f"{task}\n\n"
        "START NOW: if local work is required, your first response must be a LAIN_TOOL action."
    )

    tool_map = dict(tools or {})
    inspect = tool_map.pop("inspect", None)
    if inspect is not None:
        inspected = inspect(task)
        prompt += f"\n\nINITIAL INSPECTION RESULT:\n{inspected}"

    if not tool_map:
        return ask(prompt)

    return run_tool_loop(
        prompt,
        ask=lambda next_prompt: ask(next_prompt, think=False),
        tools=tool_map,
        max_steps=8,
        on_event=on_event,
    )


dispatch = execute
