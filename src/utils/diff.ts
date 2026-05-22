import fs from "node:fs/promises";
import path from "node:path";

function countLines(text: string) {
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!normalized) {
    return 0;
  }
  return normalized.split("\n").length;
}

function prefixLines(prefix: string, text: string) {
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!normalized) {
    return "";
  }
  return normalized
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export async function createReplacePatch(
  repoPath: string,
  replacements: Record<string, string>
) {
  const hunks = await Promise.all(
    Object.entries(replacements).map(async ([relativePath, newContent]) => {
      const absolutePath = path.join(repoPath, relativePath);
      const oldContent = await fs.readFile(absolutePath, "utf8");
      const oldLineCount = countLines(oldContent);
      const newLineCount = countLines(newContent);

      return [
        `diff --git a/${relativePath} b/${relativePath}`,
        `--- a/${relativePath}`,
        `+++ b/${relativePath}`,
        `@@ -1,${oldLineCount} +1,${newLineCount} @@`,
        prefixLines("-", oldContent),
        prefixLines("+", newContent)
      ]
        .filter(Boolean)
        .join("\n");
    })
  );

  return `${hunks.join("\n")}\n`;
}
