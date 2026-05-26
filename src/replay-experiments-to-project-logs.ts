import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { flush, initLogger, traced } from "braintrust";
import { logExecutionArtifacts } from "./artifacts.js";
import { defaultProjectName } from "./braintrust-demo.js";
import type { AgentTrace, CommandResult, EvalOutput, ScoreResult } from "./types.js";
import { loadEnvFile } from "./utils/env.js";

const execFileAsync = promisify(execFile);

type ExperimentSummary = {
  id: string;
  name: string;
  project_id: string;
  created: string;
  commit?: string;
};

type ViewLogsEnvelope = {
  items: Array<{
    row: {
      id: string;
      root_span_id?: string;
      is_root?: boolean | null;
    };
  }>;
};

type ViewSpanEnvelope = {
  item: {
    id: string;
    input?: unknown;
    expected?: unknown;
    output?: EvalOutput;
    metadata?: Record<string, unknown> | null;
    metrics?: Record<string, unknown> | null;
    scores?: Record<string, number> | null;
    root_span_id?: string;
    span_id?: string;
  };
};

type ReplayOptions = {
  envFile?: string;
  project: string;
  projectId?: string;
  since?: string;
  offset: number;
  limit: number;
  concurrency: number;
  dryRun: boolean;
  attachArtifacts: boolean;
  strictArtifacts: boolean;
};

function optionValue(name: string) {
  return process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function parseOptions(): ReplayOptions {
  const limit = Number(optionValue("--limit") ?? "1000");
  const offset = Number(optionValue("--offset") ?? "0");
  const concurrency = Number(optionValue("--concurrency") ?? "8");
  return {
    envFile: optionValue("--env-file") ?? process.env.ONE_SHOT_DEMO_ENV_FILE,
    project: optionValue("--project") ?? process.env.BRAINTRUST_PROJECT_NAME ?? defaultProjectName,
    projectId: optionValue("--project-id"),
    since: optionValue("--since") ?? "2026-05-22T21:14:00.000Z",
    offset,
    limit,
    concurrency,
    dryRun: hasFlag("--dry-run"),
    attachArtifacts: !hasFlag("--no-attachments"),
    strictArtifacts: hasFlag("--strict-attachments")
  };
}

async function runBtJson<T>(args: string[], envFile?: string): Promise<T> {
  const fullArgs = [...args];
  if (envFile) {
    fullArgs.push(`--env-file=${envFile}`);
  }
  fullArgs.push("--json");

  const { stdout } = await execFileAsync("bt", fullArgs, {
    maxBuffer: 128 * 1024 * 1024,
    env: process.env
  });
  return JSON.parse(stdout) as T;
}

function parseTimestamp(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return timestamp;
}

function isSeedExperiment(experiment: ExperimentSummary, options: ReplayOptions) {
  if (options.projectId && experiment.project_id !== options.projectId) {
    return false;
  }
  if (!experiment.name.startsWith("main-")) {
    return false;
  }
  if (options.since && Date.parse(experiment.created) < parseTimestamp(options.since)) {
    return false;
  }
  return true;
}

function flatScores(scores: Record<string, ScoreResult> | undefined) {
  return Object.fromEntries(
    Object.entries(scores ?? {}).map(([name, result]) => [name, result.score])
  );
}

function spanNameForCommand(command: string) {
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

async function logAgentTrace(agentTrace: AgentTrace) {
  await traced(
    (span) => {
      span.log({
        output: {
          primary_agent: {
            name: "AppPatch Agent",
            role: "one-shot app builder"
          },
          possible_sub_agents: [
            {
              name: "ui_implementer",
              status: "not_spawned",
              reason: "Current demo uses one no-nonsense coding agent, but the trace reserves topology for delegation."
            },
            {
              name: "test_writer",
              status: "not_spawned",
              reason: "The primary agent owns tests in this minimal harness."
            },
            {
              name: "execution_scorer",
              status: "external_backend",
              reason: "Install/build/test/start/UI checks are owned by the execution backend."
            }
          ]
        },
        metadata: {
          component: "agent_orchestrator",
          agent_count: 1,
          possible_sub_agent_count: 3
        }
      });
    },
    { name: "agent_topology" }
  );

  await traced(
    (span) => {
      span.log({
        output: {
          skills_used: agentTrace.skills_used
        },
        metadata: {
          component: "agent_trace",
          skill_count: agentTrace.skills_used.length
        }
      });
    },
    { name: "reported_skills_used" }
  );

  for (const skill of agentTrace.skills_used) {
    await traced(
      (span) => {
        span.log({
          output: skill,
          metadata: {
            component: "skill",
            skill_name: skill.name
          }
        });
      },
      { name: `skill:${skill.name}` }
    );
  }

  await traced(
    (span) => {
      span.log({
        output: {
          tools_used: agentTrace.tools_used
        },
        metadata: {
          component: "agent_trace",
          tool_count: agentTrace.tools_used.length
        }
      });
    },
    { name: "reported_tools_used" }
  );

  for (const tool of agentTrace.tools_used) {
    await traced(
      (span) => {
        span.log({
          output: tool,
          metadata: {
            component: "tool",
            tool_name: tool.name
          }
        });
      },
      { name: `tool:${tool.name}` }
    );
  }

  await traced(
    (span) => {
      span.log({
        output: {
          key_decisions: agentTrace.key_decisions,
          known_risks: agentTrace.known_risks
        },
        metadata: {
          component: "agent_reasoning_summary",
          key_decision_count: agentTrace.key_decisions.length,
          known_risk_count: agentTrace.known_risks.length
        }
      });
    },
    { name: "decision_and_risk_summary" }
  );
}

async function logCommand(command: CommandResult, cwdBasename: string) {
  await traced(
    (span) => {
      span.log({
        input: {
          command: command.command,
          cwd_basename: cwdBasename,
          timeout_ms: command.timeout_ms
        },
        output: {
          ok: command.ok,
          exit_code: command.exit_code,
          duration_ms: command.duration_ms
        },
        metadata: {
          scorer: scorerForCommand(command.command),
          stdout_excerpt: command.stdout_excerpt,
          stderr_excerpt: command.stderr_excerpt,
          execution_mode: command.execution_mode,
          execution_location: command.execution_location ?? "replayed"
        }
      });
    },
    { name: spanNameForCommand(command.command) }
  );
}

async function logExecution(output: EvalOutput) {
  const cwdBasename = output.execution.workdir.split(/[\\/]/).pop() ?? output.case_id;
  await traced(
    (span) => {
      span.log({
        input: {
          backend: output.execution.backend,
          repo_url: output.execution.repo_url,
          repo_commit_sha: output.execution.repo_commit_sha,
          repo_path: output.execution.repo_path
        },
        output: {
          duration_ms: output.execution.duration_ms,
          fast_install: output.execution.fast_install,
          artifact_filenames: output.execution.artifacts
        },
        metadata: {
          component: "execution_backend",
          replayed_for_project_logs: true
        }
      });
    },
    { name: "execution_backend" }
  );

  await logCommand(output.execution.patch_apply, cwdBasename);
  for (const command of output.execution.commands) {
    await logCommand(command, cwdBasename);
  }

  await traced(
    (span) => {
      span.log({
        input: {
          expected_terms: output.execution.ui_health.checked_terms
        },
        output: {
          ok: output.scores.BasicUIHealth?.score === 1,
          matched_terms: output.execution.ui_health.matched_terms,
          inspected_files: output.execution.ui_health.inspected_files
        },
        metadata: {
          scorer: "BasicUIHealth",
          explanation: output.scores.BasicUIHealth?.metadata?.explanation,
          replayed_for_project_logs: true
        }
      });
    },
    { name: "basic_ui_health" }
  );
}

async function logScorers(scores: Record<string, ScoreResult>) {
  for (const [name, result] of Object.entries(scores)) {
    await traced(
      (span) => {
        span.log({
          input: {
            scorer: name
          },
          output: {
            score: result.score
          },
          scores: {
            [name]: result.score
          },
          metadata: {
            ...(result.metadata ?? {}),
            scorer: name,
            replayed_for_project_logs: true
          }
        });
      },
      {
        name: `score:${name}`,
        type: "score"
      }
    );
  }
}

async function replayExperiment(experiment: ExperimentSummary, options: ReplayOptions) {
  const logs = await runBtJson<ViewLogsEnvelope>(
    [
      "view",
      "logs",
      "--object-ref",
      `experiment:${experiment.id}`,
      "--limit",
      "1",
      "--since",
      experiment.created
    ],
    options.envFile
  );
  const rootRow = logs.items[0]?.row;
  if (!rootRow) {
    throw new Error(`Experiment ${experiment.id} has no root row.`);
  }

  const full = await runBtJson<ViewSpanEnvelope>(
    ["view", "span", "--object-ref", `experiment:${experiment.id}`, "--id", rootRow.id],
    options.envFile
  );
  const output = full.item.output;
  if (!output?.agent_trace || !output.execution || !output.scores) {
    throw new Error(`Experiment ${experiment.id} root row does not look like a one-shot eval output.`);
  }

  await traced(
    async (span) => {
      if (options.attachArtifacts) {
        const artifacts = await logExecutionArtifacts(span, output, {
          strictBundle: options.strictArtifacts
        });
        output.execution.artifacts = artifacts;
      }

      span.log({
        input: full.item.input,
        expected: full.item.expected,
        output: {
          case_id: output.case_id,
          summary: output.summary,
          files_changed: output.files_changed,
          patch: output.patch,
          agent_trace: output.agent_trace,
          scores: output.scores,
          metrics: output.metrics,
          execution_summary: {
            backend: output.execution.backend,
            repo_commit_sha: output.execution.repo_commit_sha,
            repo_url: output.execution.repo_url,
            fast_install: output.execution.fast_install,
            command_count: output.execution.commands.length,
            artifacts: output.execution.artifacts
          }
        },
        scores: flatScores(output.scores),
        metadata: {
          ...(full.item.metadata ?? {}),
          case_id: output.case_id,
          source_object_type: "experiment",
          source_experiment_id: experiment.id,
          source_experiment_name: experiment.name,
          source_root_span_id: full.item.root_span_id,
          source_span_id: full.item.span_id,
          topics_seed: true,
          replayed_for_project_logs: true,
          one_shot_flow: "prompt_plus_repo_sha_to_patch_to_execution_backend_to_project_logs"
        },
        metrics: output.metrics
      });

      await logAgentTrace(output.agent_trace);
      await logExecution(output);
      await logScorers(output.scores);
    },
    {
      name: "one_shot_coding_agent_trace",
      type: "task",
      spanAttributes: {
        purpose: "topics_seed_replay"
      }
    }
  );
}

async function main() {
  const options = parseOptions();
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("--limit must be a positive integer.");
  }
  if (!Number.isInteger(options.offset) || options.offset < 0) {
    throw new Error("--offset must be a non-negative integer.");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer.");
  }

  loadEnvFile(options.envFile);
  if (!process.env.BRAINTRUST_API_KEY) {
    throw new Error("BRAINTRUST_API_KEY is required.");
  }

  const experiments = await runBtJson<ExperimentSummary[]>(
    ["experiments", "list", "--project", options.project],
    options.envFile
  );
  const selected = experiments
    .filter((experiment) => isSeedExperiment(experiment, options))
    .slice(options.offset, options.offset + options.limit);

  process.stdout.write(
    `Selected ${selected.length} experiment traces to replay into project logs for ${options.project} (offset=${options.offset}).\n`
  );
  if (options.dryRun) {
    process.stdout.write(
      JSON.stringify(
        selected.slice(0, 20).map((experiment) => ({
          id: experiment.id,
          name: experiment.name,
          created: experiment.created,
          commit: experiment.commit
        })),
        null,
        2
      ) + "\n"
    );
    return;
  }

  initLogger({
    projectName: options.project,
    setCurrent: true,
    asyncFlush: true
  });

  let nextIndex = 0;
  let completed = 0;
  let failed = 0;
  const failures: Array<{ id: string; name: string; error: string }> = [];

  async function worker(workerId: number) {
    while (nextIndex < selected.length) {
      const index = nextIndex;
      nextIndex += 1;
      const experiment = selected[index];
      try {
        await replayExperiment(experiment, options);
      } catch (error) {
        failed += 1;
        failures.push({
          id: experiment.id,
          name: experiment.name,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        completed += 1;
        if (completed % 25 === 0 || completed === selected.length) {
          process.stdout.write(
            `[project-log replay] worker=${workerId} completed=${completed}/${selected.length} failed=${failed}\n`
          );
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, selected.length) }, (_, index) => worker(index + 1))
  );
  await flush();

  if (failures.length > 0) {
    process.stderr.write(`Replay failures:\n${JSON.stringify(failures.slice(0, 20), null, 2)}\n`);
  }

  process.stdout.write(`Replayed ${completed - failed}/${selected.length} traces into project logs.\n`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

await main();
