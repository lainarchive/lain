"""Command-line entry point for lain."""

from __future__ import annotations

import argparse
import platform
import sys
from pathlib import Path

from . import __version__
from .agents.yukari import dispatch, route
from .checkpoints import checkpoint_root, create_checkpoint, list_checkpoints
from .history import history_path, recent_history, record_decision, record_event
from .memory import recent, remember, search
from .models.llama import backend_name, model_name, model_path, ollama_model
from .projects import discover, find_project, inspect, load, project_roots, registry_path, save
from .state import MODES, PROJECT_STATES, clear_mission, operating_picture, set_active_project, set_mode, set_project_state, start_mission, state_path


def _show_event(event: str, data: dict) -> None:
    """Render concise execution events without exposing model internals."""
    if event == "tool_call":
        name = data.get("name", "unknown")
        arguments = data.get("arguments", {})
        if name == "write_file":
            print(f"[tool] write_file → {arguments.get('path', '?')}")
        elif name == "read_file":
            print(f"[tool] read_file → {arguments.get('path', '?')}")
        elif name == "run_command":
            argv = arguments.get("argv", [])
            print(f"[tool] run_command → {' '.join(str(part) for part in argv)}")
        elif name == "list_directory":
            print(f"[tool] list_directory → {arguments.get('path', '.')}")
        elif name == "git_status":
            print("[tool] git_status")
        elif name == "git_diff":
            print("[tool] git_diff")
        else:
            print(f"[tool] {name}")
    elif event == "tool_result":
        output = str(data.get("output", "")).strip()
        status = "ok" if data.get("ok", False) else "failed"
        if output:
            first_line = output.splitlines()[0]
            print(f"      ↳ {status}: {first_line}")
        else:
            print(f"      ↳ {status}")
    elif event == "invalid":
        print(f"[tool] protocol error: {data.get('error', 'invalid action')}")
    elif event == "max_steps":
        print(f"[tool] stopped: maximum of {data.get('step', '?')} steps reached")


def _print_projects(projects: list, *, roots: tuple[Path, ...] | None = None) -> None:
    print("lain. projects")
    print()
    if not projects:
        print("no projects found")
        if roots:
            print()
            print("roots")
            for root in roots:
                print(f"  {root}")
        return

    print("PROJECTS")
    print()
    for project in projects:
        print(f"{project.name:<16} {project.kind:<10} {project.path}")
    print()
    print(f"{len(projects)} project{'s' if len(projects) != 1 else ''} found")


def _print_project_context(context) -> None:
    project = context.project
    print("lain. project")
    print()
    print(project.name.upper())
    print("─" * 40)
    print()
    print(f"path       {project.path}")
    print(f"type       {project.kind}")
    if context.git_branch is not None:
        print(f"git        {context.git_branch}")
        print(f"status     {context.git_status or 'unavailable'}")
    else:
        print("git        no")

    if project.markers:
        print()
        print("markers")
        for marker in project.markers:
            print(f"  {marker}")

    if context.top_level:
        print()
        print("structure")
        for entry in context.top_level:
            print(f"  {entry}")

    if context.readme:
        print()
        print(f"readme     {context.readme}")


def _backend_display() -> str:
    """Return a concise display name for the active model backend."""
    backend = backend_name()
    if backend == "ollama":
        return f"Ollama / {ollama_model()}"
    if backend == "llama.cpp":
        return "llama.cpp / CUDA0"
    return backend


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="lain",
        description="lain. local development environment",
    )
    subparsers = parser.add_subparsers(dest="command")

    ask_parser = subparsers.add_parser("ask", help="give a task to Yukari")
    ask_parser.add_argument("prompt", nargs="+", help="task to send through the orchestrator")

    route_parser = subparsers.add_parser("route", help="show which specialist Yukari selects")
    route_parser.add_argument("prompt", nargs="+", help="task to classify")

    model_parser = subparsers.add_parser("model", help="show the active local model")
    model_parser.add_argument("action", nargs="?", choices=("show",), default="show")

    subparsers.add_parser("status", help="show concise lain. system status")

    state_parser = subparsers.add_parser("state", help="show and manage Lain operating state")
    state_subparsers = state_parser.add_subparsers(dest="state_command")
    state_subparsers.add_parser("show", help="show the current operating picture")
    mode_parser = state_subparsers.add_parser("mode", help="set authority mode")
    mode_parser.add_argument("mode", choices=MODES)
    use_parser = state_subparsers.add_parser("use", help="set the active project")
    use_parser.add_argument("project")
    project_state_parser = state_subparsers.add_parser("project-state", help="set a project lifecycle state")
    project_state_parser.add_argument("project")
    project_state_parser.add_argument("state", choices=PROJECT_STATES)
    mission_parser = state_subparsers.add_parser("mission", help="start or clear the current mission")
    mission_parser.add_argument("objective", nargs="*", help="mission objective; omit with --clear")
    mission_parser.add_argument("--project", default=None)
    mission_parser.add_argument("--phase", default="planning")
    mission_parser.add_argument("--clear", action="store_true")
    mission_phase_parser = state_subparsers.add_parser("mission-phase", help="set the current mission phase")
    mission_phase_parser.add_argument("phase")
    mission_complete_parser = state_subparsers.add_parser("mission-complete", help="record an explicit completed mission item")
    mission_complete_parser.add_argument("item", nargs="+")
    mission_pending_parser = state_subparsers.add_parser("mission-pending", help="replace the current pending mission items")
    mission_pending_parser.add_argument("items", nargs="*")
    mission_verify_parser = state_subparsers.add_parser("mission-verify", help="set mission verification state")
    mission_verify_parser.add_argument("verification", choices=("pending", "verified", "failed"))

    projects_parser = subparsers.add_parser("projects", help="inspect and discover local projects")
    projects_subparsers = projects_parser.add_subparsers(dest="projects_command")
    scan_parser = projects_subparsers.add_parser("scan", help="discover projects and refresh the registry")
    scan_parser.add_argument("--root", action="append", type=Path, help="project root to scan; repeatable")

    project_parser = subparsers.add_parser("project", help="inspect one registered project")
    project_parser.add_argument("name", help="project name or exact registered path")

    checkpoint_parser = subparsers.add_parser("checkpoint", help="create and inspect known-good Git checkpoints")
    checkpoint_subparsers = checkpoint_parser.add_subparsers(dest="checkpoint_command")
    create_checkpoint_parser = checkpoint_subparsers.add_parser("create", help="record the current clean Git commit")
    create_checkpoint_parser.add_argument("project")
    list_checkpoint_parser = checkpoint_subparsers.add_parser("list", help="show saved checkpoints")
    list_checkpoint_parser.add_argument("--project", default=None)
    list_checkpoint_parser.add_argument("--limit", type=int, default=20)

    history_parser = subparsers.add_parser("history", help="inspect and record decisions and events")
    history_subparsers = history_parser.add_subparsers(dest="history_command")
    decision_parser = history_subparsers.add_parser("decision", help="record a durable decision")
    decision_parser.add_argument("project")
    decision_parser.add_argument("decision", nargs="+")
    decision_parser.add_argument("--reason", required=True)
    decision_parser.add_argument("--affected", action="append", default=[])
    event_parser = history_subparsers.add_parser("event", help="record something that happened")
    event_parser.add_argument("kind")
    event_parser.add_argument("summary", nargs="+")
    event_parser.add_argument("--project", default=None)
    recent_history_parser = history_subparsers.add_parser("recent", help="show recent history")
    recent_history_parser.add_argument("--project", default=None)
    recent_history_parser.add_argument("--type", choices=("decision", "event"), default=None)
    recent_history_parser.add_argument("--limit", type=int, default=20)

    memory_parser = subparsers.add_parser("memory", help="inspect and store Keine's memory")
    memory_subparsers = memory_parser.add_subparsers(dest="memory_command")

    add_parser = memory_subparsers.add_parser("add", help="store a memory")
    add_parser.add_argument("content", nargs="+", help="memory to store")
    add_parser.add_argument("--kind", default="note", help="memory type, e.g. decision or fact")
    add_parser.add_argument("--scope", default="global", help="project or context scope")
    add_parser.add_argument("--tag", action="append", default=[], help="optional tag; repeatable")

    search_parser = memory_subparsers.add_parser("search", help="search stored memory")
    search_parser.add_argument("query", nargs="+", help="terms to search for")
    search_parser.add_argument("--scope", default=None)
    search_parser.add_argument("--limit", type=int, default=8)

    recent_parser = memory_subparsers.add_parser("recent", help="show recent memory")
    recent_parser.add_argument("--scope", default=None)
    recent_parser.add_argument("--limit", type=int, default=8)

    args = parser.parse_args()

    if args.command == "ask":
        prompt = " ".join(args.prompt)
        try:
            selected = route(prompt)
            is_general = (
                selected.agent == "Rinnosuke"
                and selected.reason == "no specialist signal; using the general development path"
            )
            if not is_general:
                print(f"[{selected.agent}] {selected.reason}")
                print()
            print(dispatch(prompt, on_event=_show_event, selected=selected))
            return 0
        except (FileNotFoundError, RuntimeError, ValueError) as exc:
            print(f"lain: {exc}", file=sys.stderr)
            return 1

    if args.command == "route":
        prompt = " ".join(args.prompt)
        selected = route(prompt)
        print(f"{selected.agent} — {selected.reason}")
        return 0

    if args.command == "model":
        print("lain. model")
        print()
        print(f"name     {model_name()}")
        print(f"backend  {_backend_display()}")
        if backend_name() == "ollama":
            print("path     managed by Ollama")
        else:
            print(f"path     {model_path()}")
        return 0

    if args.command == "state":
        if args.state_command in (None, "show"):
            picture = operating_picture()
            print("lain. operating picture")
            print()
            print(f"active project  {picture['active_project'] or '-'}")
            print(f"mode            {picture['mode']}")
            mission = picture["mission"]
            if mission:
                print(f"mission         {mission['objective']}")
                print(f"phase           {mission['phase']}")
                print(f"verification    {mission['verification']}")
            else:
                print("mission         -")
            print(f"state file      {state_path()}")
            if picture["project_states"]:
                print()
                print("projects")
                for name, project_state in sorted(picture["project_states"].items()):
                    print(f"  {name:<16} {project_state}")
            return 0
        if args.state_command == "mode":
            state = set_mode(args.mode)
            print(f"mode → {state.mode}")
            return 0
        if args.state_command == "use":
            if find_project(args.project) is None:
                print(f"lain: project not found: {args.project}", file=sys.stderr)
                return 1
            state = set_active_project(args.project)
            print(f"active project → {state.active_project}")
            return 0
        if args.state_command == "project-state":
            state = set_project_state(args.project, args.state)
            print(f"{args.project} → {state.project_states[args.project]}")
            return 0
        if args.state_command == "mission-phase":
            try:
                state = update_mission(phase=args.phase)
            except ValueError as exc:
                print(f"lain: {exc}", file=sys.stderr)
                return 1
            print(f"mission phase → {state.mission.phase}")
            return 0
        if args.state_command == "mission-complete":
            try:
                state = load_state()
                items = list(state.mission.completed) if state.mission else []
                item = " ".join(args.item)
                if item not in items:
                    items.append(item)
                state = update_mission(completed=items, phase="verification")
            except ValueError as exc:
                print(f"lain: {exc}", file=sys.stderr)
                return 1
            print(f"mission completed → {item}")
            return 0
        if args.state_command == "mission-pending":
            try:
                state = update_mission(pending=list(args.items))
            except ValueError as exc:
                print(f"lain: {exc}", file=sys.stderr)
                return 1
            print(f"mission pending → {len(state.mission.pending)} item(s)")
            return 0
        if args.state_command == "mission-verify":
            try:
                state = update_mission(verification=args.verification)
            except ValueError as exc:
                print(f"lain: {exc}", file=sys.stderr)
                return 1
            print(f"mission verification → {state.mission.verification}")
            return 0
        if args.state_command == "mission":
            if args.clear:
                clear_mission()
                print("mission cleared")
                return 0
            if not args.objective:
                print("lain: mission objective required (or use --clear)", file=sys.stderr)
                return 1
            state = start_mission(" ".join(args.objective), project=args.project, phase=args.phase)
            print(f"mission → {state.mission.objective}")
            return 0
        state_parser.print_help()
        return 0

    if args.command == "status":
        projects = load()
        print("lain.")
        print()
        print(f"version      {__version__}")
        print(f"system       {platform.system()} {platform.release()}")
        print(f"model        {model_name()}")
        print(f"backend      {_backend_display()}")
        print("orchestrator Yukari")
        print("memory       Keine")
        print("agents       8")
        print(f"projects     {len(projects)}")
        return 0

    if args.command == "projects":
        if args.projects_command == "scan":
            roots = tuple(args.root) if args.root else None
            projects = discover(roots)
            target = save(projects)
            _print_projects(projects, roots=roots or project_roots())
            print()
            print(f"registry     {target}")
            return 0

        if args.projects_command is None:
            projects = load()
            _print_projects(projects, roots=project_roots())
            if projects:
                print()
                print(f"registry     {registry_path()}")
            return 0

        projects_parser.print_help()
        return 0

    if args.command == "project":
        project = find_project(args.name)
        if project is None:
            print(f"lain: project not found: {args.name}", file=sys.stderr)
            return 1
        _print_project_context(inspect(project))
        return 0

    if args.command == "checkpoint":
        if args.checkpoint_command == "create":
            project = find_project(args.project)
            if project is None:
                print(f"lain: project not found: {args.project}", file=sys.stderr)
                return 1
            try:
                item = create_checkpoint(project.name, project.path)
            except RuntimeError as exc:
                print(f"lain: {exc}", file=sys.stderr)
                return 1
            print(f"checkpoint → {item.id[:12]}")
            print(f"commit     {item.commit}")
            print(f"path       {item.path}")
            return 0
        if args.checkpoint_command == "list":
            for item in list_checkpoints(project=args.project, limit=args.limit):
                print(f"{item.id[:12]}  {item.project:<16} {item.commit[:12]}  {item.created_at}")
            print(f"checkpoint dir  {checkpoint_root()}")
            return 0
        checkpoint_parser.print_help()
        return 0

    if args.command == "history":
        if args.history_command == "decision":
            item = record_decision(args.project, " ".join(args.decision), args.reason, args.affected)
            print(f"decision recorded {item.id[:12]}")
            return 0
        if args.history_command == "event":
            item = record_event(args.kind, " ".join(args.summary), args.project)
            print(f"event recorded {item.id[:12]}")
            return 0
        if args.history_command == "recent":
            for item in recent_history(args.limit, project=args.project, record_type=args.type):
                print(f"[{item['type']}] {item.get('created_at', '?')} — {item.get('summary') or item.get('decision')}")
                if item.get("project"):
                    print(f"  project: {item['project']}")
                if item.get("reason"):
                    print(f"  reason: {item['reason']}")
            print(f"history file  {history_path()}")
            return 0
        history_parser.print_help()
        return 0

    if args.command == "memory":
        if args.memory_command == "add":
            memory = remember(
                " ".join(args.content),
                kind=args.kind,
                scope=args.scope,
                tags=tuple(args.tag),
            )
            print(f"stored {memory.id[:12]} — [{memory.kind}] {memory.content}")
            return 0

        if args.memory_command == "search":
            results = search(" ".join(args.query), scope=args.scope, limit=args.limit)
        elif args.memory_command == "recent":
            results = recent(scope=args.scope, limit=args.limit)
        else:
            memory_parser.print_help()
            return 0

        if not results:
            print("no memories found")
            return 0
        for memory in results:
            print(f"[{memory.kind}] {memory.content}")
            print(f"  scope: {memory.scope}  tags: {', '.join(memory.tags) or '-'}")
        return 0

    print("lain.")
    print()
    print("good evening.")
    print()
    print(f"version      {__version__}")
    print(f"system       {platform.system()} {platform.release()}")
    print(f"model        {model_name()}")
    print(f"backend      {_backend_display()}")
    print("orchestrator Yukari")
    print("memory       Keine")
    print("agents       8")
    print("projects     0")
    print()
    print('try: lain ask "hello"')
    print('     lain status')
    print('     lain model')
    print('     lain route "fix my Roblox script"')
    print('     lain projects')
    print('     lain projects scan')
    print('     lain project Inkbound')
    print('     lain memory add "Use reversible changes" --kind decision')
    return 0


if __name__ == "__main__":
    sys.exit(main())
