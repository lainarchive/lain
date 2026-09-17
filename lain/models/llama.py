"""Local model backends for lain."""

from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_LLAMA = Path(r"C:\Users\User\LocalAI\llama.cpp-src\build\bin\llama-cli.exe")
DEFAULT_MODEL = Path(
    r"C:\Users\User\AppData\Local\hermes\models\qwen2.5-coder-7b-instruct-q4_k_m.gguf"
)
DEFAULT_CUDA_BIN = Path(
    r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.4\bin\x64"
)
DEFAULT_BACKEND = "ollama"
DEFAULT_OLLAMA_MODEL = "SparkLLM/Spark-X2.5-4B:latest"
DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"


def _path_env(name: str, default: Path) -> Path:
    """Resolve a configurable executable/model path."""
    return Path(os.environ.get(name, str(default))).expanduser()


def backend_name() -> str:
    """Return the configured local model backend."""
    return os.environ.get("LAIN_BACKEND", DEFAULT_BACKEND).strip().lower()


def model_path() -> Path:
    """Return the configured llama.cpp model path."""
    return _path_env("LAIN_MODEL", DEFAULT_MODEL)


def llama_path() -> Path:
    """Return the configured llama.cpp executable."""
    return _path_env("LAIN_LLAMA", DEFAULT_LLAMA)


def ollama_model() -> str:
    """Return the configured Ollama model name."""
    return os.environ.get("LAIN_OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL).strip()


def ollama_host() -> str:
    """Return the local Ollama API endpoint."""
    return os.environ.get("LAIN_OLLAMA_HOST", DEFAULT_OLLAMA_HOST).rstrip("/")


def model_name() -> str:
    """Return a concise name for the active model."""
    if backend_name() == "ollama":
        return ollama_model()
    return model_path().stem


def _ask_llama(prompt: str) -> str:
    """Send one prompt through llama.cpp."""
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


def _strip_thinking(output: str) -> str:
    """Remove visible reasoning blocks if a backend returns them anyway."""
    output = re.sub(r"<think>.*?</think>\s*", "", output, flags=re.DOTALL | re.IGNORECASE)
    output = re.sub(r"^\s*Thinking\.\.\.\s*", "", output, flags=re.IGNORECASE)
    output = re.sub(r"^\s*\.\.\.done thinking\.\s*", "", output, flags=re.IGNORECASE)
    return output.strip()


def _ask_ollama(prompt: str, *, think: bool = True) -> str:
    """Send one prompt through Ollama's local HTTP API."""
    payload = {
        "model": ollama_model(),
        "prompt": prompt,
        "stream": False,
        "think": think,
        "options": {
            "num_ctx": int(os.environ.get("LAIN_CONTEXT", "4096")),
            "num_predict": int(os.environ.get("LAIN_MAX_TOKENS", "512")),
        },
    }

    request = urllib.request.Request(
        f"{ollama_host()}/api/generate",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            body = response.read().decode("utf-8")
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"could not reach Ollama at {ollama_host()}: {exc.reason}"
        ) from exc

    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Ollama returned invalid JSON") from exc

    if data.get("error"):
        raise RuntimeError(str(data["error"]))

    output = str(data.get("response", "")).strip()
    if not output:
        raise RuntimeError("Ollama returned no output")

    if not think:
        output = _strip_thinking(output)
        if not output:
            raise RuntimeError("Ollama returned only hidden reasoning with no answer")

    return output


def ask(prompt: str, *, think: bool = True) -> str:
    """Send one prompt through the configured local model backend."""
    if backend_name() == "ollama":
        return _ask_ollama(prompt, think=think)
    if backend_name() != "llama.cpp":
        raise ValueError(f"unsupported LAIN_BACKEND: {backend_name()}")
    return _ask_llama(prompt)
