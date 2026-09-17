"""A small, explicit tool-calling loop for local agents."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping


TOOL_SENTINEL = "LAIN_TOOL"
DONE_SENTINEL = "LAIN_DONE"
DEFAULT_MAX_STEPS = 8
MAX_TRANSCRIPT_CHARS = 48_000
MAX_TOOL_OUTPUT_CHARS = 12_000


@dataclass(frozen=True)
class ParsedAction:
    kind: str
    name: str | None = None
    arguments: dict[str, Any] | None = None
    answer: str = ""


def parse_action(text: str) -> ParsedAction:
    """Parse one model action using a deliberately tiny wire protocol."""
    stripped = text.strip()
    if stripped.startswith(DONE_SENTINEL):
        return ParsedAction("done", answer=stripped[len(DONE_SENTINEL):].strip())

    match = re.search(rf"(?m)^{re.escape(TOOL_SENTINEL)}\s*$", stripped)
    if not match:
        return ParsedAction("answer", answer=stripped)

    payload = stripped[match.end():].strip()
    decoder = json.JSONDecoder()
    try:
        value, end = decoder.raw_decode(payload)
    except json.JSONDecodeError as exc:
        return ParsedAction("invalid", answer=f"Invalid tool-call JSON: {exc.msg}")

    # Tool calls are a two-line wire protocol. Reject trailing model prose or
    # a second JSON object instead of silently accepting only the first object.
    if payload[end:].strip():
        return ParsedAction("invalid", answer="Invalid tool-call JSON: unexpected text after JSON object.")

    if not isinstance(value, dict):
        return ParsedAction("invalid", answer="Invalid tool call: payload must be a JSON object.")

    name = value.get("name")
    arguments = value.get("arguments", {})
    if not isinstance(name, str) or not name:
        return ParsedAction("invalid", answer="Invalid tool call: 'name' must be a non-empty string.")
    if not isinstance(arguments, dict):
        return ParsedAction("invalid", answer="Invalid tool call: 'arguments' must be an object.")

    return ParsedAction("tool", name=name, arguments=arguments)


def _clip(value: str) -> str:
    if len(value) <= MAX_TOOL_OUTPUT_CHARS:
        return value
    return value[:MAX_TOOL_OUTPUT_CHARS] + "\n...[tool output truncated]"


def _execution_facts(events: list[dict[str, Any]]) -> str:
    """Build a factual execution record from tool results, not model claims."""
    successful: list[str] = []
    failed: list[str] = []
    for event in events:
        if event.get("event") != "tool_result":
            continue
        name = str(event.get("name", "unknown"))
        output = str(event.get("output", "")).strip()
        if event.get("ok"):
            successful.append(f"{name}: {output or 'completed successfully'}")
        else:
            failed.append(f"{name}: {output or 'failed'}")

    lines = ["ACTUAL TOOL EXECUTION (authoritative):"]
    if successful:
        lines.append("Successful:")
        lines.extend(f"- {item}" for item in successful)
    if failed:
        lines.append("Failed:")
        lines.extend(f"- {item}" for item in failed)
    if not successful and not failed:
        lines.append("- No tools completed successfully.")
    return "\n".join(lines)


def run(
    initial_prompt: str,
    *,
    ask: Callable[[str], str],
    tools: Mapping[str, Callable[..., Any]],
    max_steps: int = DEFAULT_MAX_STEPS,
    on_event: Callable[[str, dict[str, Any]], None] | None = None,
) -> str:
    """Let a model request tools, receive results, and continue until done."""
    if not 1 <= max_steps <= 16:
        raise ValueError("max_steps must be between 1 and 16")

    transcript = initial_prompt.strip()
    last_answer = ""
    events: list[dict[str, Any]] = []

    def emit(event: str, **data: Any) -> None:
        record = {"event": event, **data}
        events.append(record)
        if on_event is not None:
            on_event(event, data)

    for step in range(1, max_steps + 1):
        response = ask(transcript)
        action = parse_action(response)

        if action.kind == "done":
            emit("done", step=step)
            answer = action.answer or last_answer or "The agent finished without a final answer."
            return f"{answer}\n\n{_execution_facts(events)}"

        if action.kind == "answer":
            emit("plain_answer", step=step)
            return f"{action.answer}\n\n{_execution_facts(events)}"

        if action.kind == "invalid":
            emit("invalid", step=step, error=action.answer)
            transcript = (
                f"{transcript}\n\n"
                f"SYSTEM TOOL ERROR (step {step}): {action.answer}\n"
                "Your previous tool call was malformed. Retry the SAME intended action now.\n"
                "Output exactly two lines: LAIN_TOOL, then one complete JSON object. "
                "No markdown, no prose, no trailing text."
            )[-MAX_TRANSCRIPT_CHARS:]
            last_answer = action.answer
            continue

        assert action.name is not None
        assert action.arguments is not None
        emit("tool_call", step=step, name=action.name, arguments=action.arguments)
        tool = tools.get(action.name)
        if tool is None:
            result = f"Unknown tool '{action.name}'. Available tools: {', '.join(sorted(tools))}"
            ok = False
        else:
            try:
                value = tool(**action.arguments)
                result = getattr(value, "output", str(value))
                ok = bool(getattr(value, "ok", True))
            except Exception as exc:
                result = f"Tool '{action.name}' failed: {type(exc).__name__}: {exc}"
                ok = False

        result = _clip(str(result))
        emit("tool_result", step=step, name=action.name, ok=ok, output=result)
        transcript = (
            f"{transcript}\n\n"
            f"TOOL CALL (step {step}): {json.dumps({'name': action.name, 'arguments': action.arguments}, ensure_ascii=False)}\n"
            f"TOOL RESULT (step {step}):\n{result}\n\n"
            "Continue the task. Use another tool if needed. When finished, output "
            "LAIN_DONE followed by the final user-facing answer."
        )[-MAX_TRANSCRIPT_CHARS:]
        last_answer = result

    emit("max_steps", step=max_steps)
    return f"The agent reached the maximum tool steps without producing a final answer.\n\n{_execution_facts(events)}"
