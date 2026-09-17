"""Command-line entry point for lain."""

from __future__ import annotations

import argparse
import platform
import sys

from . import __version__
from .agents.yukari import dispatch, route


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

    print("lain.")
    print()
    print("good evening.")
    print()
    print(f"version      {__version__}")
    print(f"system       {platform.system()} {platform.release()}")
    print("model        Qwen2.5-Coder 7B")
    print("backend      llama.cpp / CUDA0")
    print("orchestrator Yukari")
    print("agents       8")
    print("projects     0")
    print()
    print('try: lain ask "hello"')
    print('     lain route "fix my Roblox script"')
    return 0


if __name__ == "__main__":
    sys.exit(main())
