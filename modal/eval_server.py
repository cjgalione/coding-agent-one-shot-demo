"""Modal deployment for Braintrust remote eval dev server."""

from __future__ import annotations

import asyncio
import os
import subprocess
from collections import deque

import httpx
import modal
from fastapi import FastAPI, Request, Response

DEVSERVER_PORT = int(os.environ.get("BRAINTRUST_DEVSERVER_PORT", "8300"))
UPSTREAM_BASE = f"http://127.0.0.1:{DEVSERVER_PORT}"

CORS_ALLOWED_HEADERS = [
    "Authorization",
    "Content-Type",
    "X-Amz-Date",
    "X-Api-Key",
    "X-Amz-Security-Token",
    "x-bt-auth-token",
    "x-bt-parent",
    "x-bt-org-name",
    "x-bt-project-id",
    "x-bt-stream-fmt",
    "x-bt-use-cache",
    "x-bt-use-gateway",
    "x-stainless-os",
    "x-stainless-lang",
    "x-stainless-package-version",
    "x-stainless-runtime",
    "x-stainless-runtime-version",
    "x-stainless-arch",
]

modal_image = (
    modal.Image.debian_slim()
    .apt_install("curl", "git", "ca-certificates", "tar", "gzip")
    .pip_install("modal", "fastapi[standard]", "httpx")
    .run_commands(
        "cd /tmp && curl -fsSL https://github.com/braintrustdata/bt/releases/latest/download/bt-x86_64-unknown-linux-gnu.tar.gz -o bt.tar.gz && tar -xzf bt.tar.gz && install bt-x86_64-unknown-linux-gnu/bt /usr/local/bin/bt"
    )
    .run_commands("curl -fsSL https://deb.nodesource.com/setup_20.x | bash -")
    .apt_install("nodejs")
    .add_local_dir("src", remote_path="/root/src", copy=True)
    .add_local_dir("evals", remote_path="/root/evals", copy=True)
    .add_local_dir("data", remote_path="/root/data", copy=True)
    .add_local_dir("prompts", remote_path="/root/prompts", copy=True)
    .add_local_dir("skills", remote_path="/root/skills", copy=True)
    .add_local_dir("fixtures", remote_path="/root/fixtures", copy=True)
    .add_local_file("package.json", "/root/package.json", copy=True)
    .add_local_file("package-lock.json", "/root/package-lock.json", copy=True)
    .add_local_file("tsconfig.json", "/root/tsconfig.json", copy=True)
    .run_commands("cd /root && npm ci")
)

app = modal.App(
    os.environ.get("MODAL_APP_NAME", "coding-agent-one-shot-remote-eval"),
    image=modal_image,
)

_secrets = [modal.Secret.from_name("coding-agent-one-shot-demo")]


@app.function(secrets=_secrets, min_containers=1, timeout=3600)
@modal.concurrent(max_inputs=10)
@modal.asgi_app()
def braintrust_eval_server() -> FastAPI:
    eval_app = FastAPI(title="Coding Agent One-Shot Braintrust Remote Eval")
    state: dict[str, object] = {"proc": None, "tail": deque(maxlen=160)}

    def _log_reader(stream, tail: deque[str], label: str) -> None:
        for line in iter(stream.readline, ""):
            entry = f"[{label}] {line.rstrip()}"
            tail.append(entry)
            print(entry, flush=True)

    async def _start_devserver_if_needed() -> None:
        proc = state.get("proc")
        if isinstance(proc, subprocess.Popen) and proc.poll() is None:
            return

        env = os.environ.copy()
        env.setdefault("BRAINTRUST_PROJECT_NAME", "coding-agent-one-shot-demo")
        env.setdefault("ONE_SHOT_EXECUTION_BACKEND", "local")
        env.setdefault("ONE_SHOT_DEMO_FAST_INSTALL", "1")

        tail = state["tail"]
        assert isinstance(tail, deque)

        proc = subprocess.Popen(
            [
                "bt",
                "eval",
                "--project",
                "coding-agent-one-shot-demo",
                "--runner",
                "tsx",
                "--dev",
                "--dev-host",
                "0.0.0.0",
                "--dev-port",
                str(DEVSERVER_PORT),
                "evals/one-shot-remote.eval.ts",
            ],
            cwd="/root",
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        state["proc"] = proc
        asyncio.create_task(asyncio.to_thread(_log_reader, proc.stdout, tail, "eval:stdout"))
        asyncio.create_task(asyncio.to_thread(_log_reader, proc.stderr, tail, "eval:stderr"))

        deadline = asyncio.get_event_loop().time() + 60
        while True:
            current = state.get("proc")
            if not isinstance(current, subprocess.Popen):
                raise RuntimeError("Failed to start Braintrust eval devserver")
            if current.poll() is not None:
                recent = "\n".join(list(tail)[-30:])
                raise RuntimeError(
                    f"Braintrust eval devserver exited with {current.returncode}. Recent logs:\n{recent}"
                )
            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    await client.get(f"{UPSTREAM_BASE}/")
                    return
            except Exception:
                if asyncio.get_event_loop().time() > deadline:
                    recent = "\n".join(list(tail)[-30:])
                    raise RuntimeError(f"Timed out waiting for Braintrust eval devserver. Recent logs:\n{recent}")
                await asyncio.sleep(0.5)

    @eval_app.on_event("startup")
    async def startup_event() -> None:
        await _start_devserver_if_needed()

    @eval_app.on_event("shutdown")
    async def shutdown_event() -> None:
        proc = state.get("proc")
        if isinstance(proc, subprocess.Popen) and proc.poll() is None:
            proc.terminate()

    @eval_app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
    async def proxy(path: str, request: Request) -> Response:
        await _start_devserver_if_needed()

        query = request.url.query
        upstream_url = f"{UPSTREAM_BASE}/{path}"
        if query:
            upstream_url = f"{upstream_url}?{query}"

        body = await request.body()
        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in {"host", "content-length", "connection", "transfer-encoding"}
        }

        async with httpx.AsyncClient(timeout=300.0) as client:
            upstream_response = await client.request(
                method=request.method,
                url=upstream_url,
                content=body,
                headers=headers,
            )

        response_headers = {
            key: value
            for key, value in upstream_response.headers.items()
            if key.lower() not in {"content-encoding", "transfer-encoding", "connection"}
        }
        for header in CORS_ALLOWED_HEADERS:
            response_headers.setdefault("access-control-allow-headers", ",".join(CORS_ALLOWED_HEADERS))
        response_headers.setdefault("access-control-allow-origin", "https://www.braintrust.dev")
        response_headers.setdefault("access-control-allow-credentials", "true")

        return Response(
            content=upstream_response.content,
            status_code=upstream_response.status_code,
            headers=response_headers,
            media_type=upstream_response.headers.get("content-type"),
        )

    return eval_app


@app.local_entrypoint()
def test() -> None:
    print("Deploy with: modal deploy modal/eval_server.py")
