"""Rinnosuke: the development specialist for lain."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

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
    on_event: Callable[[str, dict[str, Any]], None] | None = None,
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
        "You are a careful software engineer with access to real local tools.\n"
        "Your job is to ACT on the user's task, not merely describe code.\n\n"
        "AVAILABLE LOCAL TOOLS:\n"
        f"{describe_tools()}\n\n"
        "MANDATORY TOOL PROTOCOL:\n"
        "The runtime executes tools only when you emit a structured LAIN_TOOL action.\n"
        "For a task that asks you to create, edit, inspect, run, test, or verify something, "
        "you MUST use the tools and MUST NOT answer with a code snippet instead.\n"
        "A code snippet, Python example, shell command written as prose, or explanation is NOT execution.\n\n"
        "To call a tool, output EXACTLY two lines and nothing else for that turn:\n"
        "LAIN_TOOL\n"
        "{\"name\":\"tool_name\",\"arguments\":{}}\n"
        "The second line MUST be complete valid JSON on one line. Do not use markdown fences. Do not add commentary.\n\n"
        "Example — inspect a file:\n"
        "LAIN_TOOL\n"
        "{\"name\":\"read_file\",\"arguments\":{\"path\":\"README.md\"}}\n\n"
        "Example — create a new file:\n"
        "LAIN_TOOL\n"
        "{\"name\":\"write_file\",\"arguments\":{\"path\":\"sandbox/hello.py\",\"content\":\"def greet(name):\\n    return 'Hello, ' + name + '!'\\n\"}}\n\n"
        "Example — verify with Python:\n"
        "LAIN_TOOL\n"
        "{\"name\":\"run_command\",\"arguments\":{\"argv\":[\"python\",\"-c\",\"from sandbox.hello import greet; assert greet('Alice') == 'Hello, Alice!'; print(greet('Alice'))\"]}}\n\n"
        "After every TOOL RESULT, decide whether another real tool action is needed.\n"
        "When all requested work and verification are actually complete, output:\n"
        "LAIN_DONE\n"
        "followed by a concise final answer.\n"
        "Never claim a file was created, changed, inspected, a command ran, or a test passed unless the runtime supplied the corresponding TOOL RESULT.\n\n"
        "SOURCE INSPECTION RULES:\n"
        "1. If the user names an existing source file, inspect that exact file BEFORE any verification command.\n"
        "2. For a full source inspection, call read_file with only the path. Do not request a one-line range unless the user explicitly asks for a range.\n"
        "3. Treat the complete read_file TOOL RESULT as the source of truth. Never infer missing lines from the task, memory, or an earlier answer.\n"
        "4. If the task says a file is deliberately broken, independently compare the inspected implementation against the exact required behavior.\n"
        "5. If the inspected implementation is wrong, edit the file BEFORE running the verification command.\n"
        "6. Existing files require overwrite=true on write_file. Include overwrite=true when the task requires modifying an existing file.\n"
        "7. If the implementation is already correct, do not edit it; verify it and report that no change was necessary.\n\n"
        "DEVELOPMENT PROTOCOL:\n"
        "1. Inspect before editing when existing state matters.\n"
        "2. Identify the smallest set of affected files.\n"
        "3. Read relevant code and understand its interfaces.\n"
        "4. Change only what the task requires.\n"
        "5. Never verify a requested fix before the required edit has happened, unless inspection proved no edit is needed.\n"
        "6. Run focused verification after changes.\n"
        "7. Inspect git diff/status before declaring success when appropriate.\n"
        "8. Never use shell syntax; run_command receives an argv list and shell execution is disabled.\n"
        "9. If a tool refuses an operation, correct the tool arguments and retry the intended operation; do not silently change the task.\n"
        "10. If a tool-call JSON error occurs, immediately retry the same intended action using exactly the two-line LAIN_TOOL format above. Do not abandon the task.\n"
        "11. If evidence is insufficient, say exactly what remains unverified.\n\n"
        "WORK PLAN:\n"
        f"{plan_text}\n\n"
        "PROJECT CONTEXT:\n"
        f"{context_text}\n\n"
        f"USER TASK:\n{task}\n\n"
        "START NOW: if the task requires local work, your first response must be a LAIN_TOOL action."
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
        ask=ask,
        tools=tool_map,
        max_steps=8,
        on_event=on_event,
    )


dispatch = execute
