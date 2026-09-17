"""Command-line entry point for lain."""

from __future__ import annotations

import argparse
import platform
import sys

from . import __version__
from .models.llama import ask


def main() -> int:
    parser = argparse.ArgumentParser(prog="lain", description="lain. local development environment")
    subparsers = parser.add_subparsers(dest="command")
    ask_parser = subparsers.add_parser("ask", help="ask the local model")
    ask_parser.add_argument("prompt", nargs="+", help="prompt to send to Qwen")

    args = parser.parse_args()

    if args.command == "ask":
        prompt = " ".join(args.prompt)
        try:
            print(ask(prompt))
            return 0
        except (FileNotFoundError, RuntimeError) as exc:
            print(f"lain: {exc}", file=sys.stderr)
            return 1

    print("lain.")
    print()
    print("good evening.")
    print()
    print(f"version      {__version__}")
    print(f"system       {platform.system()} {platform.release()}")
    print("model        Qwen2.5-Coder 7B")
    print("backend      llama.cpp / CUDA0")
    print("agents       8")
    print("projects     0")
    print()
    print('try: lain ask "hello"')
    return 0


if __name__ == "__main__":
    sys.exit(main())
