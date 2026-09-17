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


def ask(prompt: str) -> str:
    """Send one prompt to the local Qwen model through llama.cpp."""
    llama = Path(os.environ.get("LAIN_LLAMA", DEFAULT_LLAMA))
    model = Path(os.environ.get("LAIN_MODEL", DEFAULT_MODEL))

    if not llama.exists():
        raise FileNotFoundError(f"llama.cpp executable not found: {llama}")
    if not model.exists():
        raise FileNotFoundError(f"model not found: {model}")

    env = os.environ.copy()
    cuda_bin = Path(os.environ.get("LAIN_CUDA_BIN", DEFAULT_CUDA_BIN))
    env["PATH"] = f"{cuda_bin};{env.get('PATH', '')}"

    command = [
        str(llama),
        "-m", str(model),
        "--device", "CUDA0",
        "-ngl", "all",
        "-c", "4096",
        "-n", "512",
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

    # llama-cli emits the prompt before the generated answer. Strip the echoed
    # prompt when it appears as the first non-empty line.
    lines = output.splitlines()
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines and lines[0].strip() == prompt.strip():
        lines.pop(0)

    # Remove the interactive prompt marker and llama-cli performance footer.
    output = "\n".join(lines).strip()
    if output.startswith("> "):
        output = output[2:].lstrip()
    if "\n[ Prompt:" in output:
        output = output.split("\n[ Prompt:", 1)[0].rstrip()

    if not output:
        raise RuntimeError("llama.cpp generated an empty answer")

    return output
