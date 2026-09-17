"""Local llama.cpp backend for lain."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

DEFAULT_LLAMA = Path(r"C:\Users\User\LocalAI\llama.cpp-src\build\bin\llama-cli.exe")
DEFAULT_MODEL = Path(
    r"C:\Users\User\AppData\Local\hermes\models\qwen2.5-coder-7b-instruct-q4_k_m.gguf"
)
DEFAULT_CUDA_BIN = Path(
    r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.4\bin\x64"
)


def _path_env(name: str, default: Path) -> Path:
    """Resolve a configurable executable/model path."""
    return Path(os.environ.get(name, str(default))).expanduser()


def model_path() -> Path:
    """Return the currently configured local model path."""
    return _path_env("LAIN_MODEL", DEFAULT_MODEL)


def llama_path() -> Path:
    """Return the currently configured llama.cpp executable."""
    return _path_env("LAIN_LLAMA", DEFAULT_LLAMA)


def model_name() -> str:
    """Return a concise name for the active model file."""
    return model_path().stem


def ask(prompt: str) -> str:
    """Send one prompt to the configured local model through llama.cpp."""
    llama = llama_path()
    model = model_path()

    if not llama.exists():
        raise FileNotFoundError(f"llama.cpp executable not found: {llama}")
    if not model.exists():
        raise FileNotFoundError(f"model not found: {model}")

    env = os.environ.copy()
    cuda_bin = _path_env("LAIN_CUDA_BIN", DEFAULT_CUDA_BIN)
    env["PATH"] = f"{cuda_bin};{env.get('PATH', '')}"

    command = [
        str(llama),
        "-m", str(model),
        "--device", "CUDA0",
        "-ngl", "all",
        "-c", os.environ.get("LAIN_CONTEXT", "4096"),
        "-n", os.environ.get("LAIN_MAX_TOKENS", "512"),
        "-p", prompt,
        "-st",
    ]

    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        check=False,
    )

    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(detail or f"llama.cpp exited with code {result.returncode}")

    output = result.stdout.strip()
    if not output:
        raise RuntimeError("llama.cpp returned no output")

    marker = "\n> "
    if marker in output:
        output = output.rsplit(marker, 1)[1]

    lines = output.splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines and lines[0].strip() == prompt.strip():
        lines.pop(0)

    output = "\n".join(lines).strip()

    for footer in ("\n[ Prompt:", "\n[ Generation:", "\n[ Total:"):
        if footer in output:
            output = output.split(footer, 1)[0].rstrip()

    if not output:
        raise RuntimeError("llama.cpp generated an empty answer")

    return output
