import fs from "node:fs/promises";
import path from "node:path";
import { fromRoot } from "./paths.js";

const ignoredDirs = new Set(["node_modules", "dist", ".git", ".vite"]);

export async function readText(relativePath: string) {
  return fs.readFile(fromRoot(relativePath), "utf8");
}

export async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readText(relativePath)) as T;
}

export async function listFiles(root: string): Promise<string[]> {
  const absoluteRoot = fromRoot(root);
  const files: string[] = [];

  async function walk(current: string) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoredDirs.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else {
        files.push(path.relative(absoluteRoot, absolutePath));
      }
    }
  }

  await walk(absoluteRoot);
  return files.sort();
}

export async function loadRelevantFiles(repoPath: string) {
  const candidates = [
    "package.json",
    "src/App.tsx",
    "src/App.css",
    "src/App.test.tsx",
    "src/main.tsx",
    "vite.config.ts"
  ];

  const sections: string[] = [];
  for (const candidate of candidates) {
    const fullPath = fromRoot(repoPath, candidate);
    try {
      const content = await fs.readFile(fullPath, "utf8");
      sections.push(`--- ${candidate} ---\n${content}`);
    } catch {
      // Missing files are useful signal for a real agent, but not fatal here.
    }
  }
  return sections.join("\n\n");
}

export async function loadSkills(skillNames: string[]) {
  const sections = await Promise.all(
    skillNames.map(async (skillName) => {
      const content = await readText(`skills/${skillName}`);
      return `--- ${skillName} ---\n${content}`;
    })
  );
  return sections.join("\n\n");
}
