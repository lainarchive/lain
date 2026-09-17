"""Tests for lain's controlled local tools."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lain.tools.local import ToolError, git_status, list_directory, read_file, run_command, write_file


class LocalToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.env = patch.dict("os.environ", {"LAIN_WORKSPACE": str(self.root)})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.tempdir.cleanup()

    def test_read_and_write_round_trip(self) -> None:
        result = write_file("src/example.py", "print('hello')\n")
        self.assertTrue(result.ok)
        self.assertIn("1: print('hello')", read_file("src/example.py").output)

    def test_existing_file_requires_explicit_overwrite(self) -> None:
        write_file("example.txt", "one")
        with self.assertRaises(ToolError):
            write_file("example.txt", "two")

    def test_paths_cannot_escape_workspace(self) -> None:
        with self.assertRaises(ToolError):
            read_file("../outside.txt")

    def test_command_does_not_use_shell(self) -> None:
        result = run_command(["python", "-c", "print('ok')"])
        self.assertTrue(result.ok)
        self.assertEqual(result.output, "ok")

    def test_high_impact_commands_are_blocked(self) -> None:
        with self.assertRaises(ToolError):
            run_command(["shutdown", "/s"])

    def test_directory_listing_is_workspace_relative(self) -> None:
        write_file("src/example.py", "x = 1\n")
        result = list_directory(".", recursive=True)
        self.assertIn("src/", result.output)
        self.assertIn("src/example.py", result.output)

    def test_git_status_runs_inside_workspace(self) -> None:
        result = git_status()
        self.assertTrue(result.ok or "not a git repository" in result.output.lower())


if __name__ == "__main__":
    unittest.main()
