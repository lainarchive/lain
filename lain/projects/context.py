"""Live context inspection for registered lain projects."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

from .discovery import Project, load

MAX_TOP_LEVEL_ENTRIES = 24


@dataclass(frozen=True)
class ProjectContext:
    """Factual live state collected from a local project."""

    project: Project
    git_branch: str | None
    git_status: str | None
    top_level: tuple[str, ...]
    readme: str | None


def _git(path: Path, *args: str) -> str | None:
    """Run a read-only git query inside a project."""
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=path,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    if result.returncode != 0:
        return None
    value = result.stdout.strip()
    return value or None


def _git_state(path: Path) -> tuple[str | None, str | None]:
    """Return branch and concise working-tree state."""
    branch = _git(path, "branch", "--show-current")
    porcelain = _git(path, "status", "--porcelain")
    if porcelain is None:
        status = None
    elif porcelain:
        status = "modified"
    else:
        status = "clean"
    return branch, status


def _top_level(path: Path) -> tuple[str, ...]:
    """Return a bounded, sorted view of the project's immediate contents."""
    try:
        entries = sorted(path.iterdir(), key=lambda item: item.name.casefold())
    except OSError:
        return ()

    names: list[str] = []
    for entry in entries[:MAX_TOP_LEVEL_ENTRIES]:
        names.append(f"{entry.name}/" if entry.is_dir() else entry.name)
    return tuple(names)


def _readme(path: Path) -> str | None:
    """Read only the first useful lines of a project README."""
    for filename in ("README.md", "README.rst", "README.txt", "README"):
        candidate = path / filename
        if not candidate.is_file():
            continue
        try:
            lines = candidate.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return None
        useful = [line.strip() for line in lines if line.strip()][:3]
        return " / ".join(useful)[:240] if useful else None
    return None


def inspect(project: Project) -> ProjectContext:
    """Build live context for one discovered project."""
    path = Path(project.path)
    branch, status = _git_state(path) if ".git" in project.markers else (None, None)
    return ProjectContext(
        project=project,
        git_branch=branch,
        git_status=status,
        top_level=_top_level(path),
        readme=_readme(path),
    )


def find_project(name_or_path: str, projects: list[Project] | None = None) -> Project | None:
    """Resolve a project by registered name or exact path."""
    projects = projects if projects is not None else load()
    needle = name_or_path.casefold()
    for project in projects:
        if project.name.casefold() == needle or project.path.casefold() == needle:
            return project
    return None
