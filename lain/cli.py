"""Command-line entry point for lain."""

from __future__ import annotations

import platform
import sys

from . import __version__


def main() -> int:
    print("lain.")
    print()
    print("good evening.")
    print()
    print(f"version      {__version__}")
    print(f"system       {platform.system()} {platform.release()}")
    print("models       0")
    print("agents       8")
    print("projects     0")
    print()
    print("lain is alive. local intelligence comes next.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
