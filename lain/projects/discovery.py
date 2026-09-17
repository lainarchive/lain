"""Project discovery and registry management for lain."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path

DEFAULT_PROJECT_ROOTS = (Path("~/lain/projects"),)
DEFAULT_REGISTRY = Path("~/.lain/projects.json")


@dataclass(frozen=True)
class Project:
    """A discovered local project."""

    name: str
    path: str
    kind: str
    markers: tuple[str, ...] = ()


def _expand(path: Path) -> Path:
    return path.expanduser().resolve()


def project_roots() -> tuple[Path, ...]:
    """Return configured project roots, with an environment override."""
    raw = os.environ.get("LAIN_PROJECT_ROOTS")
    if raw:
        return tuple(_expand(Path(item)) for item in raw.split(os.pathsep) if item.strip())
    return tuple(_expand(path) for path in DEFAULT_PROJECT_ROOTS)


def registry_path() -> Path:
    """Return the project registry location."""
    return _expand(Path(os.environ.get("LAIN_PROJECT_REGISTRY", DEFAULT_REGISTRY)))


def _kind_for(path: Path) -> tuple[str, tuple[str, ...]]:
    markers: list[str] = []

    if (path / ".git").exists():
        markers.append(".git")
    if (path / "pyproject.toml").exists() or (path / "setup.py").exists():
        markers.append("pyproject.toml" if (path / "pyproject.toml").exists() else "setup.py")
        return "Python", tuple(markers)
    if (path / "package.json").exists():
        markers.append("package.json")
        return "Node", tuple(markers)
    if (path / "Cargo.toml").exists():
        markers.append("Cargo.toml")
        return "Rust", tuple(markers)
    if (path / "default.project.json").exists() or any(path.glob("*.rbxl")) or any(path.glob("*.rbxlx")):
        if (path / "default.project.json").exists():
            markers.append("default.project.json")
        if any(path.glob("*.rbxl")):
            markers.append("*.rbxl")
        if any(path.glob("*.rbxlx")):
            markers.append("*.rbxlx")
        return "Roblox", tuple(markers)
    if (path / "go.mod").exists():
        markers.append("go.mod")
        return "Go", tuple(markers)
    if (path / "CMakeLists.txt").exists():
        markers.append("CMakeLists.txt")
        return "CMake", tuple(markers)

    return ("Git" if ".git" in markers else "Unknown"), tuple(markers)


def discover(roots: tuple[Path, ...] | None = None) -> list[Project]:
    """Discover projects directly beneath the configured roots."""
    roots = roots if roots is not None else project_roots()
    found: dict[str, Project] = {}

    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.iterdir(), key=lambda item: item.name.casefold()):
            if not path.is_dir() or path.name.startswith("."):
                continue
            kind, markers = _kind_for(path)
            if kind == "Unknown":
                continue
            resolved = str(path.resolve())
            found[resolved.casefold()] = Project(path.name, resolved, kind, markers)

    return sorted(found.values(), key=lambda project: project.name.casefold())


def save(projects: list[Project], path: Path | None = None) -> Path:
    """Persist the discovered project registry as JSON."""
    target = _expand(path or registry_path())
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = [asdict(project) for project in projects]
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return target


def load(path: Path | None = None) -> list[Project]:
    """Load a previously saved project registry."""
    target = _expand(path or registry_path())
    if not target.exists():
        return []
    data = json.loads(target.read_text(encoding="utf-8"))
    return [Project(item["name"], item["path"], item["kind"], tuple(item.get("markers", ()))) for item in data]
