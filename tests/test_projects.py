"""Tests for project discovery."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lain.projects import Project, discover, load, save


class ProjectDiscoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_discovers_supported_project_types(self) -> None:
        python_project = self.root / "alpha"
        python_project.mkdir()
        (python_project / "pyproject.toml").write_text("[project]\nname='alpha'\n", encoding="utf-8")

        roblox_project = self.root / "beta"
        roblox_project.mkdir()
        (roblox_project / "default.project.json").write_text("{}", encoding="utf-8")

        unknown = self.root / "notes"
        unknown.mkdir()
        (unknown / "readme.txt").write_text("hello", encoding="utf-8")

        projects = discover((self.root,))

        self.assertEqual([project.name for project in projects], ["alpha", "beta"])
        self.assertEqual(projects[0].kind, "Python")
        self.assertEqual(projects[1].kind, "Roblox")

    def test_discovers_git_project(self) -> None:
        project = self.root / "git-project"
        project.mkdir()
        (project / ".git").mkdir()

        projects = discover((self.root,))

        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0].kind, "Git")
        self.assertIn(".git", projects[0].markers)

    def test_deduplicates_same_project_from_multiple_roots(self) -> None:
        project = self.root / "project"
        project.mkdir()
        (project / "package.json").write_text("{}", encoding="utf-8")

        projects = discover((self.root, self.root))

        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0].kind, "Node")

    def test_ignores_common_home_directories(self) -> None:
        documents = self.root / "Documents"
        documents.mkdir()
        (documents / "game.rbxl").write_text("placeholder", encoding="utf-8")

        downloads = self.root / "Downloads"
        downloads.mkdir()
        (downloads / "default.project.json").write_text("{}", encoding="utf-8")

        projects = discover((self.root,))

        self.assertEqual(projects, [])

    def test_does_not_use_nested_roblox_place_files_as_markers(self) -> None:
        project = self.root / "notes"
        project.mkdir()
        nested = project / "old"
        nested.mkdir()
        (nested / "place.rbxl").write_text("placeholder", encoding="utf-8")

        projects = discover((self.root,))

        self.assertEqual(projects, [])

    def test_environment_can_override_project_roots(self) -> None:
        project = self.root / "override"
        project.mkdir()
        (project / "Cargo.toml").write_text("[package]\nname='override'\n", encoding="utf-8")

        with patch.dict("os.environ", {"LAIN_PROJECT_ROOTS": str(self.root)}):
            projects = discover()

        self.assertEqual([project.name for project in projects], ["override"])

    def test_registry_round_trip(self) -> None:
        projects = [Project("demo", str(self.root / "demo"), "Python", ("pyproject.toml",))]
        target = self.root / "registry.json"

        save(projects, target)
        self.assertEqual(load(target), projects)
        self.assertEqual(json.loads(target.read_text(encoding="utf-8"))[0]["name"], "demo")


if __name__ == "__main__":
    unittest.main()
