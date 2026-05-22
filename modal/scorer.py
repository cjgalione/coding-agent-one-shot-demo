"""Modal remote scorer for the coding-agent one-shot demo."""

from __future__ import annotations

import base64
import os
import shutil
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Any

import modal
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


def excerpt(text: str, max_length: int = 4000) -> str:
    if len(text) <= max_length:
        return text
    edge = max_length // 2
    return f"{text[:edge]}\n...<truncated {len(text) - max_length} chars>...\n{text[-edge:]}"


class EvaluateRequest(BaseModel):
    case_id: str
    repo_url: str
    repo_commit_sha: str
    repo_path: str
    patch: str
    test_commands: list[str]
    expected_ui_terms: list[str]


def command_result(
    command: str,
    cwd: Path,
    *,
    stdin: str | None = None,
    timeout_ms: int = 120_000,
    execution_mode: str | None = None,
) -> dict[str, Any]:
    start = time.time()
    proc = subprocess.run(
        command,
        cwd=cwd,
        input=stdin,
        text=True,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout_ms / 1000,
        env={**os.environ, "CI": "1"},
    )
    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    return {
        "command": command,
        "ok": proc.returncode == 0,
        "duration_ms": int((time.time() - start) * 1000),
        "timeout_ms": timeout_ms,
        "stdout": stdout,
        "stderr": stderr,
        "stdout_excerpt": excerpt(stdout),
        "stderr_excerpt": excerpt(stderr),
        "exit_code": proc.returncode,
        "execution_mode": execution_mode,
        "execution_location": "modal",
    }


def failed_timeout_result(command: str, timeout_ms: int, start: float, error: subprocess.TimeoutExpired) -> dict[str, Any]:
    stdout = (error.stdout or "").decode() if isinstance(error.stdout, bytes) else (error.stdout or "")
    stderr = (error.stderr or "").decode() if isinstance(error.stderr, bytes) else (error.stderr or "")
    stderr = f"{stderr}\nCommand timed out."
    return {
        "command": command,
        "ok": False,
        "duration_ms": int((time.time() - start) * 1000),
        "timeout_ms": timeout_ms,
        "stdout": stdout,
        "stderr": stderr,
        "stdout_excerpt": excerpt(stdout),
        "stderr_excerpt": excerpt(stderr),
        "exit_code": None,
        "execution_mode": None,
        "execution_location": "modal",
    }


def safe_command_result(command: str, cwd: Path, **kwargs: Any) -> dict[str, Any]:
    start = time.time()
    timeout_ms = int(kwargs.get("timeout_ms", 120_000))
    try:
        return command_result(command, cwd, **kwargs)
    except subprocess.TimeoutExpired as error:
        return failed_timeout_result(command, timeout_ms, start, error)


def score(name: str, ok: bool, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "name": name,
        "score": 1 if ok else 0,
        "metadata": {
            "explanation": f"{name} {'passed' if ok else 'failed'} in Modal.",
            **(metadata or {}),
        },
    }


def command_score(name: str, result: dict[str, Any] | None) -> dict[str, Any]:
    ok = bool(result and result.get("ok"))
    return score(
        name,
        ok,
        {
            "explanation": (
                f"{name} passed because '{result['command']}' exited 0 in {result['duration_ms']}ms."
                if ok and result
                else (
                    f"{name} failed because '{result['command']}' exited {result.get('exit_code')} in {result['duration_ms']}ms."
                    if result
                    else f"{name} failed because the command was not reached."
                )
            ),
            "command": result.get("command") if result else None,
            "exit_code": result.get("exit_code") if result else None,
            "duration_ms": result.get("duration_ms") if result else None,
            "stdout_excerpt": result.get("stdout_excerpt") if result else None,
            "stderr_excerpt": result.get("stderr_excerpt") if result else None,
            "execution_location": "modal",
        },
    )


def command_by_purpose(commands: list[dict[str, Any]], purpose: str) -> dict[str, Any] | None:
    return next((command for command in commands if purpose in command["command"]), None)


def inspect_built_ui(workdir: Path, expected_terms: list[str]) -> dict[str, Any]:
    dist = workdir / "dist"
    inspected_files: list[str] = []
    chunks: list[str] = []
    for path in dist.rglob("*"):
        if path.is_file() and path.suffix in {".html", ".js", ".css"}:
            inspected_files.append(str(path.relative_to(workdir)))
            chunks.append(path.read_text(errors="ignore"))
    haystack = "\n".join(chunks).lower()
    matched_terms = [term for term in expected_terms if term.lower() in haystack]
    has_js_bundle = any(file.endswith(".js") for file in inspected_files)
    is_not_placeholder = "placeholder app" not in haystack
    return {
        "ok": has_js_bundle and is_not_placeholder and len(matched_terms) >= 2,
        "checked_terms": expected_terms,
        "matched_terms": matched_terms,
        "inspected_files": inspected_files,
    }


def make_bundle(workdir: Path, case_id: str) -> tuple[str, int]:
    bundle_path = Path(tempfile.gettempdir()) / f"{case_id}.runnable-app.tar.gz"
    if bundle_path.exists():
        bundle_path.unlink()
    with tarfile.open(bundle_path, "w:gz") as tar:
        for path in workdir.rglob("*"):
            relative = path.relative_to(workdir)
            if relative.parts and relative.parts[0] in {".git", "node_modules"}:
                continue
            tar.add(path, arcname=relative)
    data = bundle_path.read_bytes()
    return base64.b64encode(data).decode(), len(data)


def evaluate_patch(request: EvaluateRequest) -> dict[str, Any]:
    started = time.time()
    root = Path(tempfile.mkdtemp(prefix=f"{request.case_id}-"))
    clone_dir = root / "repo"
    try:
        clone = safe_command_result(f"git clone --depth 1 {request.repo_url} {clone_dir}", root, timeout_ms=120_000)
        if not clone["ok"]:
            commands: list[dict[str, Any]] = []
            apply_result = clone
            ui_health = {"checked_terms": request.expected_ui_terms, "matched_terms": [], "inspected_files": []}
        else:
            checkout = safe_command_result(f"git fetch --depth 1 origin {request.repo_commit_sha} && git checkout {request.repo_commit_sha}", clone_dir, timeout_ms=120_000)
            workdir = clone_dir / request.repo_path
            apply_result = safe_command_result(
                "git apply --whitespace=nowarn -",
                workdir,
                stdin=request.patch,
                timeout_ms=30_000,
            )
            if not checkout["ok"]:
                apply_result = checkout
            commands = []
            if apply_result["ok"]:
                for command in request.test_commands:
                    result = safe_command_result(
                        command,
                        workdir,
                        timeout_ms=180_000 if "install" in command else 120_000,
                        execution_mode="modal-npm-install" if "install" in command else None,
                    )
                    commands.append(result)
                    if not result["ok"]:
                        break
            build = command_by_purpose(commands, "build")
            ui_health = inspect_built_ui(workdir, request.expected_ui_terms) if build and build["ok"] else {
                "checked_terms": request.expected_ui_terms,
                "matched_terms": [],
                "inspected_files": [],
            }

        install = command_by_purpose(commands, "install")
        build = command_by_purpose(commands, "build")
        test = command_by_purpose(commands, "test")
        start_check = command_by_purpose(commands, "start:check")
        checks = {
            "patch_applies": bool(apply_result["ok"]),
            "installs": bool(install and install["ok"]),
            "builds": bool(build and build["ok"]),
            "tests_pass": bool(test and test["ok"]),
            "starts": bool(start_check and start_check["ok"]),
            "ui_not_blank": bool(ui_health["matched_terms"]) and len(ui_health["matched_terms"]) >= 2,
            "trace_complete": True,
        }
        scores = {
            "OneShotRunnableApp": score("OneShotRunnableApp", all(checks.values()), {"checks": checks}),
            "PatchApplies": score("PatchApplies", bool(apply_result["ok"]), {"apply_stderr_excerpt": apply_result["stderr_excerpt"]}),
            "InstallSucceeds": command_score("InstallSucceeds", install),
            "BuildSucceeds": command_score("BuildSucceeds", build),
            "TestsPass": command_score("TestsPass", test),
            "AppStarts": command_score("AppStarts", start_check),
            "BasicUIHealth": score("BasicUIHealth", bool(ui_health["ok"]), ui_health),
            "TraceCompleteness": score("TraceCompleteness", True, {"execution_location": "modal"}),
        }
        workdir = clone_dir / request.repo_path
        bundle_base64, bundle_size = make_bundle(workdir, request.case_id) if workdir.exists() else ("", 0)
        return {
            "backend": "modal-remote",
            "workdir": str(workdir),
            "repo_commit_sha": request.repo_commit_sha,
            "repo_url": request.repo_url,
            "repo_path": request.repo_path,
            "fast_install": False,
            "duration_ms": int((time.time() - started) * 1000),
            "scores": scores,
            "patch_apply": apply_result,
            "commands": commands,
            "ui_health": {
                "checked_terms": ui_health["checked_terms"],
                "matched_terms": ui_health["matched_terms"],
                "inspected_files": ui_health["inspected_files"],
            },
            "runnable_app_bundle_base64": bundle_base64,
            "runnable_app_bundle_size_bytes": bundle_size,
        }
    finally:
        shutil.rmtree(root, ignore_errors=True)


modal_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "git", "ca-certificates", "tar", "gzip")
    .run_commands("curl -fsSL https://deb.nodesource.com/setup_20.x | bash -")
    .apt_install("nodejs")
    .pip_install("fastapi[standard]", "pydantic")
)

app = modal.App("coding-agent-one-shot-modal-scorer", image=modal_image)


@app.function(timeout=1800)
@modal.concurrent(max_inputs=10)
@modal.asgi_app()
def scorer_app() -> FastAPI:
    api = FastAPI(title="Coding Agent One-Shot Modal Scorer")

    @api.post("/evaluate")
    def evaluate(request: EvaluateRequest) -> dict[str, Any]:
        try:
            return evaluate_patch(request)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    return api


@app.local_entrypoint()
def main() -> None:
    print("Deploy with: modal deploy modal/scorer.py")
