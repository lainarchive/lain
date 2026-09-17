"""Project discovery and registry management for lain."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path

DEFAULT_PROJECT_ROOTS = (Path("~"),)
DEFAULT_REGISTRY = Path("~/.lain/projects.json")

# Common home-directory folders are not project roots. This keeps broad home
# discovery useful without treating folders such as Documents or Downloads as
# projects just because they contain project files.
DEFAULT_IGNORED_DIRECTORIES = frozenset(
    {
        "AppData",
        "Contacts",
        "Cookies",
        "Desktop",
        "Documents",
        "Downloads",
        "Favorites",
        "Links",
        "Music",
        "OneDrive",
        "Pictures",
        "Saved Games",
        "Searches",
        "Videos",
    }
)


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

    if (path / ".git").is_dir():
        markers.append(".git")

    if (path / "pyproject.toml").is_file() or (path / "setup.py").is_file():
        markers.append("pyproject.toml" if (path / "pyproject.toml").is_file() else "setup.py")
        return "Python", tuple(markers)

    if (path / "package.json").is_file():
        markers.append("package.json")
        return "Node", tuple(markers)

    if (path / "Cargo.toml").is_file():
        markers.append("Cargo.toml")
        return "Rust", tuple(markers)

    # Roblox projects need a project descriptor or a place file directly in
    # the project root. Do not search recursively: arbitrary .rbxl files in
    # folders such as Documents/Downloads must not make the parent a project.
    if (path / "default.project.json").is_file():
        markers.append("default.project.json")
        return "Roblox", tuple(markers)

    rbxl = sorted(path.glob("*.rbxl"))
    rbxlx = sorted(path.glob("*.rbxlx"))
    if rbxl or rbxlx:
        if rbxl:
            markers.append("*.rbxl")
        if rbxlx:
            markers.append("*.rbxlx")
        return "Roblox", tuple(markers)

    if (path / "go.mod").is_file():
        markers.append("go.mod")
        return "Go", tuple(markers)

    if (path / "CMakeLists.txt").is_file():
        markers.append("CMakeLists.txt")
        return "CMake", tuple(markers)

    return ("Git" if ".git" in markers else "Unknown"), tuple(markers)


def discover(roots: tuple[Path, ...] | None = None) -> list[Project]:
    """Discover recognizable projects directly beneath the configured roots."""
    roots = roots if roots is not None else project_roots()
    found: dict[str, Project] = {}

    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.iterdir(), key=lambda item: item.name.casefold()):
            if not path.is_dir() or path.name.startswith("."):
                continue
            if path.name in DEFAULT_IGNORED_DIRECTORIES:
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
