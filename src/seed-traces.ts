import { spawn } from "node:child_process";
import type { DatasetCase } from "./types.js";
import { readJson } from "./utils/files.js";
import { loadEnvFile } from "./utils/env.js";

type SeedOptions = {
  count: number;
  concurrency: number;
  maxErrorRate: number;
  envFile?: string;
};

function parseOptions(): SeedOptions {
  const countArg = process.argv.find((arg) => arg.startsWith("--count="))?.slice("--count=".length);
  const concurrencyArg = process.argv
    .find((arg) => arg.startsWith("--concurrency="))
    ?.slice("--concurrency=".length);
  const maxErrorRateArg = process.argv
    .find((arg) => arg.startsWith("--max-error-rate="))
    ?.slice("--max-error-rate=".length);

  return {
    count: countArg ? Number(countArg) : 10,
    concurrency: concurrencyArg ? Number(concurrencyArg) : 1,
    maxErrorRate: maxErrorRateArg ? Number(maxErrorRateArg) : 0.1,
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

  return {
    ok: exitCode === 0,
    index,
    caseId: testCase.id,
    exitCode
  };
}

const options = parseOptions();
if (!Number.isInteger(options.count) || options.count < 1) {
  throw new Error("--count must be a positive integer.");
}
if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
  throw new Error("--concurrency must be a positive integer.");
}
if (!Number.isFinite(options.maxErrorRate) || options.maxErrorRate < 0 || options.maxErrorRate > 1) {
  throw new Error("--max-error-rate must be between 0 and 1.");
}

loadEnvFile(options.envFile);

if (!process.env.BRAINTRUST_API_KEY || !process.env.OPENAI_API_KEY) {
  throw new Error("BRAINTRUST_API_KEY and OPENAI_API_KEY are required for seed:traces.");
}

const cases = await readJson<DatasetCase[]>("data/cases.json");
let nextIndex = 0;
let completed = 0;
let failed = 0;
let aborted = false;
const failures: Array<{ index: number; caseId: string; exitCode: number | null }> = [];

async function worker(workerId: number) {
  while (!aborted) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= options.count) {
      return;
    }

    const result = await runEvalCase(cases[index % cases.length], options, index);
    completed += 1;
    if (!result.ok) {
      failed += 1;
      failures.push({
        index: result.index,
        caseId: result.caseId,
        exitCode: result.exitCode
      });
    }

    const errorRate = failed / completed;
    process.stdout.write(
      `[seed status] worker=${workerId} completed=${completed}/${options.count} failed=${failed} error_rate=${errorRate.toFixed(3)}\n`
    );

    if (completed >= Math.min(options.concurrency, 10) && errorRate > options.maxErrorRate) {
      aborted = true;
      process.stderr.write(
        `[seed abort] error_rate=${errorRate.toFixed(3)} exceeded max_error_rate=${options.maxErrorRate}. Stopping new work.\n`
      );
    }
  }
}

process.stdout.write(
  `Seeding ${options.count} real coding-agent traces with concurrency=${options.concurrency}, max_error_rate=${options.maxErrorRate}.\n`
);

await Promise.all(
  Array.from({ length: Math.min(options.concurrency, options.count) }, (_, index) => worker(index + 1))
);

if (failed > 0) {
  process.stderr.write(
    `\nSeed failures:\n${JSON.stringify(failures.slice(0, 20), null, 2)}${
      failures.length > 20 ? `\n... ${failures.length - 20} more failures omitted` : ""
    }\n`
  );
}

if (aborted) {
  throw new Error(
    `Seed run aborted after ${completed}/${options.count} traces because error rate ${(failed / completed).toFixed(
      3
    )} exceeded ${options.maxErrorRate}.`
  );
}

process.stdout.write(`\nSeeded ${completed} real coding-agent traces with ${failed} failures.\n`);
