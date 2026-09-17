"""Tests for lain's explicit model-to-tool execution loop."""

from __future__ import annotations

import unittest

from lain.core.tool_loop import parse_action, run


class ToolLoopTests(unittest.TestCase):
    def test_parse_done(self) -> None:
        action = parse_action("LAIN_DONE\nFinished the task.")
        self.assertEqual(action.kind, "done")
        self.assertEqual(action.answer, "Finished the task.")

    def test_parse_tool_call(self) -> None:
        action = parse_action(
            'LAIN_TOOL\n{"name":"read_file","arguments":{"path":"README.md"}}'
        )
        self.assertEqual(action.kind, "tool")
        self.assertEqual(action.name, "read_file")
        self.assertEqual(action.arguments, {"path": "README.md"})

    def test_loop_executes_tool_then_returns_final_answer(self) -> None:
        responses = iter(
            [
                'LAIN_TOOL\n{"name":"probe","arguments":{"value":"ok"}}',
                "LAIN_DONE\nThe probe returned ok.",
            ]
        )
        calls: list[str] = []

        def ask(prompt: str) -> str:
            calls.append(prompt)
            return next(responses)

        def probe(value: str) -> str:
            return value

        answer = run("Do the task", ask=ask, tools={"probe": probe})

        self.assertEqual(answer, "The probe returned ok.")
        self.assertEqual(len(calls), 2)
        self.assertIn("TOOL RESULT (step 1):\nok", calls[1])

    def test_unknown_tool_is_returned_to_model(self) -> None:
        responses = iter(
            [
                'LAIN_TOOL\n{"name":"missing","arguments":{}}',
                "LAIN_DONE\nHandled the missing tool.",
            ]
        )
        calls: list[str] = []

        def ask(prompt: str) -> str:
            calls.append(prompt)
            return next(responses)

        answer = run("Do the task", ask=ask, tools={"probe": lambda: "ok"})

        self.assertEqual(answer, "Handled the missing tool.")
        self.assertIn("Unknown tool 'missing'", calls[1])


if __name__ == "__main__":
    unittest.main()
