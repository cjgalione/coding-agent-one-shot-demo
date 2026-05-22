import { spawn } from "node:child_process";
import type { DatasetCase } from "./types.js";
import { readJson } from "./utils/files.js";
import { loadEnvFile } from "./utils/env.js";

type SeedOptions = {
  count: number;
  envFile?: string;
};

function parseOptions(): SeedOptions {
  const countArg = process.argv.find((arg) => arg.startsWith("--count="))?.slice("--count=".length);
  return {
    count: countArg ? Number(countArg) : 10,
    envFile:
      process.argv.find((arg) => arg.startsWith("--env-file="))?.slice("--env-file=".length) ??
      process.env.ONE_SHOT_DEMO_ENV_FILE
  };
}

async function runEvalCase(testCase: DatasetCase, options: SeedOptions, index: number) {
  const args = ["dist/eval.js", `--case=${testCase.id}`];
  if (options.envFile) {
    args.push(`--env-file=${options.envFile}`);
  }

  process.stdout.write(`\n[seed ${index + 1}/${options.count}] ${testCase.id}\n`);

  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: process.env
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`Seed run ${index + 1} failed for ${testCase.id} with exit code ${exitCode}`);
  }
}

const options = parseOptions();
if (!Number.isInteger(options.count) || options.count < 1) {
  throw new Error("--count must be a positive integer.");
}

loadEnvFile(options.envFile);

if (!process.env.BRAINTRUST_API_KEY || !process.env.OPENAI_API_KEY) {
  throw new Error("BRAINTRUST_API_KEY and OPENAI_API_KEY are required for seed:traces.");
}

const cases = await readJson<DatasetCase[]>("data/cases.json");
for (let index = 0; index < options.count; index += 1) {
  await runEvalCase(cases[index % cases.length], options, index);
}

process.stdout.write(`\nSeeded ${options.count} real coding-agent traces.\n`);
