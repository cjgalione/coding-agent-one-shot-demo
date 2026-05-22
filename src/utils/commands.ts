import { spawn } from "node:child_process";
import type { CommandResult } from "../types.js";

export function excerpt(text: string, maxLength = 4000) {
  if (text.length <= maxLength) {
    return text;
  }

  const edgeLength = Math.floor(maxLength / 2);
  return `${text.slice(0, edgeLength)}\n...<truncated ${text.length - maxLength} chars>...\n${text.slice(-edgeLength)}`;
}

export async function runCommand(
  command: string,
  cwd: string,
  options: { stdin?: string; timeoutMs?: number } = {}
): Promise<CommandResult> {
  const start = Date.now();
  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CI: "1" }
  });

  let stdout = "";
  let stderr = "";
  let didTimeout = false;

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  if (options.stdin) {
    child.stdin.write(options.stdin);
  }
  child.stdin.end();

  const timeout = setTimeout(() => {
    didTimeout = true;
    child.kill("SIGTERM");
  }, options.timeoutMs ?? 120_000);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });
  clearTimeout(timeout);

  const timedOutMessage = didTimeout ? "\nCommand timed out." : "";
  const stderrWithTimeout = stderr + timedOutMessage;
  return {
    command,
    ok: exitCode === 0 && !didTimeout,
    duration_ms: Date.now() - start,
    timeout_ms: options.timeoutMs ?? 120_000,
    stdout,
    stderr: stderrWithTimeout,
    stdout_excerpt: excerpt(stdout),
    stderr_excerpt: excerpt(stderrWithTimeout),
    exit_code: exitCode
  };
}
