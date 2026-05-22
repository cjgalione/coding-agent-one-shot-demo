import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const port = 5177 + Math.floor(Math.random() * 1000);
const child = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["exec", "vite", "preview", "--", "--host", "127.0.0.1", "--port", String(port)],
  { detached: process.platform !== "win32", stdio: "pipe" }
);

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

async function waitForServer() {
  const url = `http://127.0.0.1:${port}/`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const html = await response.text();
        if (!html.includes('id="root"')) {
          throw new Error("HTML response did not include the React root node.");
        }
        return;
      }
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Vite preview did not become healthy. Output:\n${output}`);
}

async function staticDistCheck() {
  const html = await readFile(join("dist", "index.html"), "utf8");
  const assets = await readdir(join("dist", "assets"));
  const hasRoot = html.includes('id="root"');
  const hasJsAsset = assets.some((asset) => asset.endsWith(".js"));
  if (!hasRoot || !hasJsAsset) {
    throw new Error("Built app did not include a React root and JavaScript asset.");
  }
}

let failure;

try {
  await waitForServer();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const listenBlocked = message.includes("listen EPERM");
  if (!listenBlocked || process.env.ONE_SHOT_DEMO_REQUIRE_LISTEN === "1") {
    failure = error;
  } else {
    try {
      await staticDistCheck();
    } catch (staticError) {
      failure = staticError;
    }
  }
} finally {
  if (process.platform === "win32") {
    child.kill("SIGTERM");
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  child.stdout.destroy();
  child.stderr.destroy();
}

if (failure) {
  throw failure;
}
