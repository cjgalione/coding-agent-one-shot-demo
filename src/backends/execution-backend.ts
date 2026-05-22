import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fsExtra from "fs-extra";
import { traced } from "braintrust";
import type {
  AgentResult,
  CommandResult,
  DatasetCase,
  ExecutionReport,
  ScoreResult
} from "../types.js";
import { fromRoot } from "../utils/paths.js";
import { excerpt, runCommand } from "../utils/commands.js";

type EvaluatePatchInput = {
  testCase: DatasetCase;
  agentResult: AgentResult;
};

export interface ExecutionBackend {
  name: string;
  evaluatePatch(input: EvaluatePatchInput): Promise<ExecutionReport>;
}

function score(name: string, ok: boolean, metadata?: Record<string, unknown>): ScoreResult {
  return {
    name,
    score: ok ? 1 : 0,
    metadata: {
      explanation: ok ? `${name} passed.` : `${name} failed.`,
      ...metadata
    }
  };
}

function commandScore(name: string, result?: CommandResult) {
  const ok = Boolean(result?.ok);
  return score(name, ok, {
    explanation: result
      ? ok
        ? `${name} passed because '${result.command}' exited 0 in ${result.duration_ms}ms.`
        : `${name} failed because '${result.command}' exited ${result.exit_code ?? "without an exit code"} in ${result.duration_ms}ms.`
      : `${name} failed because the command was not reached. An earlier scorer stopped execution.`,
    command: result?.command,
    exit_code: result?.exit_code,
    duration_ms: result?.duration_ms,
    stdout_excerpt: result?.stdout_excerpt,
    stderr_excerpt: result?.stderr_excerpt,
    execution_mode: result?.execution_mode,
    execution_location: result?.execution_location
  });
}

function traceComplete(agentResult: AgentResult) {
  const trace = agentResult.agent_trace;
  return (
    trace.skills_used.length > 0 &&
    trace.tools_used.length > 0 &&
    trace.key_decisions.length > 0 &&
    Array.isArray(trace.known_risks)
  );
}

async function inspectBuiltUi(workdir: string, expectedTerms: string[]) {
  const distDir = path.join(workdir, "dist");
  const inspectedFiles: string[] = [];
  const chunks: string[] = [];

  async function walk(current: string) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (/\.(html|js|css)$/.test(entry.name)) {
        inspectedFiles.push(path.relative(workdir, absolutePath));
        chunks.push(await fs.readFile(absolutePath, "utf8"));
      }
    }
  }

  await walk(distDir);
  const haystack = chunks.join("\n").toLowerCase();
  const matchedTerms = expectedTerms.filter((term) =>
    haystack.includes(term.toLowerCase())
  );
  const hasReactBundle = inspectedFiles.some((file) => file.endsWith(".js"));
  const isNotPlaceholder = !haystack.includes("placeholder app");

  return {
    ok: hasReactBundle && isNotPlaceholder && matchedTerms.length >= 2,
    checked_terms: expectedTerms,
    matched_terms: matchedTerms,
    inspected_files: inspectedFiles
  };
}

function commandByPurpose(commands: CommandResult[], purpose: string) {
  return commands.find((command) => command.command.includes(purpose));
}

function oneShotRunnableAppScore(args: {
  applyResult: CommandResult;
  fixtureMatches: boolean;
  install?: CommandResult;
  build?: CommandResult;
  test?: CommandResult;
  startCheck?: CommandResult;
  uiHealthOk: boolean;
  traceOk: boolean;
}) {
  const checks = {
    patch_applies: args.applyResult.ok && args.fixtureMatches,
    installs: Boolean(args.install?.ok),
    builds: Boolean(args.build?.ok),
    tests_pass: Boolean(args.test?.ok),
    starts: Boolean(args.startCheck?.ok),
    ui_not_blank: args.uiHealthOk,
    trace_complete: args.traceOk
  };

  return score("OneShotRunnableApp", Object.values(checks).every(Boolean), {
    explanation: Object.values(checks).every(Boolean)
      ? "The app was one-shot runnable: the patch applied, install/build/test/start/UI health all passed, and the agent trace was complete."
      : "The app was not one-shot runnable because one or more required execution checks failed.",
    checks
  });
}

function commandSpanName(command: string) {
  if (command.startsWith("git apply")) {
    return "apply_patch";
  }
  if (command.includes("install")) {
    return "install";
  }
  if (command.includes("build")) {
    return "build";
  }
  if (command.includes("test")) {
    return "test";
  }
  if (command.includes("start:check")) {
    return "start_check";
  }
  return "run_command";
}

function scorerForCommand(command: string) {
  if (command.startsWith("git apply")) {
    return "PatchApplies";
  }
  if (command.includes("install")) {
    return "InstallSucceeds";
  }
  if (command.includes("build")) {
    return "BuildSucceeds";
  }
  if (command.includes("test")) {
    return "TestsPass";
  }
  if (command.includes("start:check")) {
    return "AppStarts";
  }
  return "CommandRuns";
}

async function traceCommand(command: string, workdir: string, run: () => Promise<CommandResult>) {
  return traced(
    async (span) => {
      span.log({
        input: {
          command,
          cwd_basename: path.basename(workdir)
        },
        metadata: {
          scorer: scorerForCommand(command),
          fast_install: process.env.ONE_SHOT_DEMO_FAST_INSTALL !== "0",
          execution_location: "local"
        }
      });

      const result = await run();
      span.log({
        output: {
          ok: result.ok,
          exit_code: result.exit_code,
          duration_ms: result.duration_ms
        },
        metadata: {
          stdout_excerpt: result.stdout_excerpt,
          stderr_excerpt: result.stderr_excerpt,
          timeout_ms: result.timeout_ms,
          execution_mode: result.execution_mode,
          execution_location: result.execution_location ?? "local"
        }
      });
      return result;
    },
    { name: commandSpanName(command) }
  );
}

async function runInstallCommand(command: string, workdir: string): Promise<CommandResult> {
  const start = Date.now();
  const shouldFastInstall =
    command.trim() === "npm install" && process.env.ONE_SHOT_DEMO_FAST_INSTALL !== "0";

  if (!shouldFastInstall) {
    const result = await runCommand(command, workdir, { timeoutMs: 180_000 });
    return { ...result, execution_mode: "strict-npm-install", execution_location: "local" };
  }

  const target = path.join(workdir, "node_modules");
  try {
    await fs.symlink(fromRoot("node_modules"), target, "dir");
    const stdout =
      "Linked root node_modules for local demo speed. Set ONE_SHOT_DEMO_FAST_INSTALL=0 to run npm install inside each temp repo.";
    return {
      command,
      ok: true,
      duration_ms: Date.now() - start,
      timeout_ms: 180_000,
      stdout,
      stderr: "",
      stdout_excerpt: excerpt(stdout),
      stderr_excerpt: "",
      exit_code: 0,
      execution_mode: "fast-linked-node-modules",
      execution_location: "local"
    };
  } catch (error) {
    const stderr = error instanceof Error ? error.message : String(error);
    return {
      command,
      ok: false,
      duration_ms: Date.now() - start,
      timeout_ms: 180_000,
      stdout: "",
      stderr,
      stdout_excerpt: "",
      stderr_excerpt: excerpt(stderr),
      exit_code: 1,
      execution_mode: "fast-linked-node-modules",
      execution_location: "local"
    };
  }
}

export class LocalExecutionBackend implements ExecutionBackend {
  name = "local-tempdir";

  async evaluatePatch({ testCase, agentResult }: EvaluatePatchInput) {
    const start = Date.now();
    const sourceDir = fromRoot(testCase.repo_path);
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), `${testCase.id}-`));

    await fsExtra.copy(sourceDir, workdir, {
      filter: (src) => {
        const basename = path.basename(src);
        return basename !== "node_modules" && basename !== "dist";
      }
    });

    const fixtureSha = await fs.readFile(path.join(workdir, ".one-shot-fixture-sha"), "utf8");
    const fixtureMatches = fixtureSha.trim() === testCase.repo_commit_sha;

    const applyCommand = "git apply --whitespace=nowarn -";
    const applyResult = await traceCommand(applyCommand, workdir, () =>
      runCommand(applyCommand, workdir, {
        stdin: agentResult.patch,
        timeoutMs: 30_000
      })
    );

    const commands: CommandResult[] = [];
    if (applyResult.ok && fixtureMatches) {
      for (const command of testCase.test_commands) {
        const result = await traceCommand(command, workdir, () =>
          command.includes("install")
            ? runInstallCommand(command, workdir)
            : runCommand(command, workdir, { timeoutMs: 120_000 })
        );
        commands.push(result);
        if (!result.ok) {
          break;
        }
      }
    }

    const install = commandByPurpose(commands, "install");
    const build = commandByPurpose(commands, "build");
    const test = commandByPurpose(commands, "test");
    const startCheck = commandByPurpose(commands, "start:check");

    let uiHealth = {
      ok: false,
      checked_terms: testCase.expected_ui_terms,
      matched_terms: [] as string[],
      inspected_files: [] as string[]
    };

    await traced(
      async (span) => {
        span.log({
          input: {
            cwd_basename: path.basename(workdir),
            expected_terms: testCase.expected_ui_terms
          },
          metadata: {
            scorer: "BasicUIHealth",
            skipped: !build?.ok
          }
        });

        if (build?.ok) {
          try {
            uiHealth = await inspectBuiltUi(workdir, testCase.expected_ui_terms);
          } catch {
            uiHealth = {
              ok: false,
              checked_terms: testCase.expected_ui_terms,
              matched_terms: [],
              inspected_files: []
            };
          }
        }

        span.log({
          output: {
            ok: uiHealth.ok,
            matched_terms: uiHealth.matched_terms,
            inspected_files: uiHealth.inspected_files
          }
        });
      },
      { name: "basic_ui_health" }
    );

    const traceOk = traceComplete(agentResult);
    const oneShotScore = oneShotRunnableAppScore({
      applyResult,
      fixtureMatches,
      install,
      build,
      test,
      startCheck,
      uiHealthOk: uiHealth.ok,
      traceOk
    });

    const scores = {
      OneShotRunnableApp: oneShotScore,
      PatchApplies: score("PatchApplies", applyResult.ok && fixtureMatches, {
        explanation:
          applyResult.ok && fixtureMatches
            ? "The unified diff applied cleanly to the requested fixture SHA."
            : "The patch did not apply cleanly or the copied fixture SHA did not match the dataset input.",
        fixture_sha_matches: fixtureMatches,
        expected_fixture_sha: testCase.repo_commit_sha,
        apply_exit_code: applyResult.exit_code,
        apply_duration_ms: applyResult.duration_ms,
        apply_stderr_excerpt: applyResult.stderr_excerpt
      }),
      InstallSucceeds: commandScore("InstallSucceeds", install),
      BuildSucceeds: commandScore("BuildSucceeds", build),
      TestsPass: commandScore("TestsPass", test),
      AppStarts: commandScore("AppStarts", startCheck),
      BasicUIHealth: score("BasicUIHealth", uiHealth.ok, {
        explanation: uiHealth.ok
          ? `Built UI looked healthy: inspected ${uiHealth.inspected_files.length} files and matched ${uiHealth.matched_terms.length}/${uiHealth.checked_terms.length} expected UI terms.`
          : `Built UI health failed: matched ${uiHealth.matched_terms.length}/${uiHealth.checked_terms.length} expected UI terms or the built app still looked blank/placeheld.`,
        matched_terms: uiHealth.matched_terms,
        checked_terms: uiHealth.checked_terms,
        inspected_files: uiHealth.inspected_files
      }),
      TraceCompleteness: score("TraceCompleteness", traceOk, {
        explanation: traceOk
          ? "The agent returned skills used, tools used, key decisions, and known risks."
          : "The agent trace was missing one or more required sections.",
        skills_used: agentResult.agent_trace.skills_used.length,
        tools_used: agentResult.agent_trace.tools_used.length,
        key_decisions: agentResult.agent_trace.key_decisions.length,
        known_risks: agentResult.agent_trace.known_risks.length
      })
    };

    return {
      backend: this.name,
      workdir,
      repo_commit_sha: testCase.repo_commit_sha,
      repo_url: testCase.repo_url,
      repo_path: testCase.repo_path,
      fast_install: process.env.ONE_SHOT_DEMO_FAST_INSTALL !== "0",
      duration_ms: Date.now() - start,
      scores,
      patch_apply: applyResult,
      commands,
      ui_health: {
        checked_terms: uiHealth.checked_terms,
        matched_terms: uiHealth.matched_terms,
        inspected_files: uiHealth.inspected_files
      }
    };
  }
}

export class RemoteExecutionBackend implements ExecutionBackend {
  name = "remote-infra-stub";

  async evaluatePatch(_input: EvaluatePatchInput): Promise<ExecutionReport> {
    throw new Error(
      "RemoteExecutionBackend is a handoff point for private infrastructure. " +
        "In production, this would POST the prompt, repo SHA, patch, skills, " +
        "and config to a private sandbox or Kubernetes harness, then return the same " +
        "ExecutionReport shape with scores and metrics."
    );
  }
}

async function traceReportedCommand(result: CommandResult, cwdBasename: string) {
  await traced(
    async (span) => {
      span.log({
        input: {
          command: result.command,
          cwd_basename: cwdBasename,
          timeout: result.timeout_ms
        },
        output: {
          ok: result.ok,
          exit_code: result.exit_code,
          duration_ms: result.duration_ms
        },
        metadata: {
          scorer: scorerForCommand(result.command),
          stdout_excerpt: result.stdout_excerpt,
          stderr_excerpt: result.stderr_excerpt,
          timeout_ms: result.timeout_ms,
          execution_mode: result.execution_mode,
          execution_location: "modal"
        }
      });
    },
    { name: commandSpanName(result.command) }
  );
}

async function replayRemoteReport(report: ExecutionReport) {
  const cwdBasename = path.basename(report.workdir);
  await traceReportedCommand(report.patch_apply, cwdBasename);
  for (const command of report.commands) {
    await traceReportedCommand(command, cwdBasename);
  }
  await traced(
    async (span) => {
      span.log({
        input: {
          cwd_basename: cwdBasename,
          expected_terms: report.ui_health.checked_terms
        },
        output: {
          ok: report.scores.BasicUIHealth?.score === 1,
          matched_terms: report.ui_health.matched_terms,
          inspected_files: report.ui_health.inspected_files
        },
        metadata: {
          scorer: "BasicUIHealth",
          execution_location: "modal"
        }
      });
    },
    { name: "basic_ui_health" }
  );
}

export class ModalExecutionBackend implements ExecutionBackend {
  name = "modal-remote";

  async evaluatePatch({ testCase, agentResult }: EvaluatePatchInput): Promise<ExecutionReport> {
    const scorerUrl = process.env.MODAL_SCORER_URL;
    if (!scorerUrl) {
      throw new Error("MODAL_SCORER_URL is required when ONE_SHOT_EXECUTION_BACKEND=modal.");
    }
    if (!testCase.repo_url) {
      throw new Error(`Case ${testCase.id} is missing repo_url for Modal execution.`);
    }

    const response = await fetch(`${scorerUrl.replace(/\/$/, "")}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        case_id: testCase.id,
        repo_url: testCase.repo_url,
        repo_commit_sha: testCase.repo_commit_sha,
        repo_path: testCase.repo_path,
        patch: agentResult.patch,
        test_commands: testCase.test_commands,
        expected_ui_terms: testCase.expected_ui_terms
      })
    });

    if (!response.ok) {
      throw new Error(`Modal scorer failed with ${response.status}: ${await response.text()}`);
    }

    const report = (await response.json()) as ExecutionReport;
    await replayRemoteReport(report);
    return report;
  }
}

export function createExecutionBackend(): ExecutionBackend {
  return process.env.ONE_SHOT_EXECUTION_BACKEND === "modal"
    ? new ModalExecutionBackend()
    : new LocalExecutionBackend();
}
