"""Command-line entry point for lain."""

from __future__ import annotations

import argparse
import platform
import sys

from . import __version__
from .agents.yukari import dispatch, route
from .memory import recent, remember, search


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
            print(f"[{selected.agent}] {selected.reason}")
            print()
            print(dispatch(prompt))
            return 0
        except (FileNotFoundError, RuntimeError) as exc:
            print(f"lain: {exc}", file=sys.stderr)
            return 1

    if args.command == "route":
        prompt = " ".join(args.prompt)
        selected = route(prompt)
        print(f"{selected.agent} — {selected.reason}")
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
    print("model        Qwen2.5-Coder 7B")
    print("backend      llama.cpp / CUDA0")
    print("orchestrator Yukari")
    print("memory       Keine")
    print("agents       8")
    print("projects     0")
    print()
    print('try: lain ask "hello"')
    print('     lain route "fix my Roblox script"')
    print('     lain memory add "Use reversible changes" --kind decision')
    return 0


if __name__ == "__main__":
    sys.exit(main())
