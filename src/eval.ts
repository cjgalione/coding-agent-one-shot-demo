import type { DatasetCase, EvalOutput, ScoreResult } from "./types.js";
import { createExecutionBackend } from "./backends/execution-backend.js";
import { runCodingAgent } from "./agent/run-agent.js";
import { readJson } from "./utils/files.js";
import { loadEnvFile } from "./utils/env.js";
import { flushBraintrust, initDemoLogger, projectName } from "./braintrust-demo.js";
import { logExecutionArtifacts } from "./artifacts.js";

export const deterministicScores = [
  "OneShotRunnableApp",
  "PatchApplies",
  "InstallSucceeds",
  "BuildSucceeds",
  "TestsPass",
  "AppStarts",
  "BasicUIHealth",
  "TraceCompleteness"
];

export type RunOptions = {
  mock: boolean;
  caseId?: string;
  envFile?: string;
  localOnly: boolean;
  agent?: {
    systemPrompt?: string;
    taskWrapperPrompt?: string;
    model?: string;
  };
};

export async function runCase(testCase: DatasetCase, options: RunOptions): Promise<EvalOutput> {
  const started = Date.now();
  const agentResult = await runCodingAgent(testCase, {
    mock: options.mock,
    systemPrompt: options.agent?.systemPrompt,
    taskWrapperPrompt: options.agent?.taskWrapperPrompt,
    model: options.agent?.model
  });
  const execution = await createExecutionBackend().evaluatePatch({
    testCase,
    agentResult
  });

  return {
    case_id: testCase.id,
    summary: agentResult.summary,
    patch: agentResult.patch,
    files_changed: agentResult.files_changed,
    agent_trace: agentResult.agent_trace,
    scores: execution.scores,
    metrics: {
      duration_ms: Date.now() - started,
      estimated_input_tokens: agentResult.estimated_tokens?.input ?? 0,
      estimated_output_tokens: agentResult.estimated_tokens?.output ?? 0,
      estimated_cost_usd: agentResult.estimated_cost_usd ?? 0
    },
    execution: {
      backend: execution.backend,
      workdir: execution.workdir,
      repo_commit_sha: execution.repo_commit_sha,
      repo_url: execution.repo_url,
      repo_path: execution.repo_path,
      fast_install: execution.fast_install,
      duration_ms: execution.duration_ms,
      patch_apply: execution.patch_apply,
      commands: execution.commands,
      ui_health: execution.ui_health,
      runnable_app_bundle_base64: execution.runnable_app_bundle_base64,
      runnable_app_bundle_size_bytes: execution.runnable_app_bundle_size_bytes,
      artifacts: undefined
    }
  };
}

export async function loadCases(options: Pick<RunOptions, "caseId">) {
  const cases = await readJson<DatasetCase[]>("data/cases.json");
  if (!options.caseId) {
    return cases;
  }

  const testCase = cases.find((candidate) => candidate.id === options.caseId);
  if (!testCase) {
    throw new Error(`Unknown case id: ${options.caseId}`);
  }
  return [testCase];
}

export function scoreValue(output: EvalOutput, name: string) {
  return output.scores[name]?.score ?? 0;
}

export function namedScore(
  name: string,
  scorer: (args: { output: EvalOutput; expected: { expected_ui_terms: string[] } }) => ScoreResult
) {
  return (args: { output: EvalOutput; expected: { expected_ui_terms: string[] } }) => {
    const result = scorer(args);
    return {
      name,
      score: result.score,
      metadata: result.metadata ?? {}
    };
  };
}

export function deterministicScore(output: EvalOutput, name: string): ScoreResult {
  return output.scores[name] ?? {
    name,
    score: 0,
    metadata: {
      explanation: `${name} failed because the scorer result was missing from the execution report.`
    }
  };
}

export function summarizeScores(scores: Record<string, ScoreResult>) {
  return Object.fromEntries(
    Object.entries(scores).map(([name, result]) => [name, result.score])
  );
}

async function runLocal(options: RunOptions) {
  const cases = await loadCases(options);
  const outputs: EvalOutput[] = [];

  for (const testCase of cases) {
    const output = await runCase(testCase, options);
    outputs.push(output);
    process.stdout.write(
      `${JSON.stringify(
        {
          case_id: output.case_id,
          summary: output.summary,
          scores: summarizeScores(output.scores),
          metrics: output.metrics,
          workdir: output.execution.workdir
        },
        null,
        2
      )}\n`
    );
  }

  const passCount = outputs.filter((output) =>
    deterministicScores.every((name) => scoreValue(output, name) === 1)
  ).length;
  process.stdout.write(
    `\nLocal eval complete: ${passCount}/${outputs.length} cases passed all deterministic scores.\n`
  );
}

async function runBraintrust(options: RunOptions) {
  const cases = await loadCases(options);
  const braintrust = await import("braintrust");
  const Eval = (braintrust as any).Eval;

  if (!Eval) {
    throw new Error("The installed braintrust package did not expose Eval.");
  }

  await Eval(projectName(), {
    data: () =>
      cases.map((testCase) => ({
        input: {
          user_request: testCase.user_request,
          repo_commit_sha: testCase.repo_commit_sha,
          repo_url: testCase.repo_url,
          repo_path: testCase.repo_path,
          skills: testCase.skills,
          agent_config: testCase.agent_config,
          test_commands: testCase.test_commands
        },
        expected: {
          expected_ui_terms: testCase.expected_ui_terms
        },
        metadata: {
          case_id: testCase.id,
          one_shot_flow: "prompt_plus_repo_sha_to_patch_to_remote_execution_backend"
        }
      })),
    task: async (input: any) => {
      const testCase = cases.find((candidate) => candidate.repo_commit_sha === input.repo_commit_sha && candidate.user_request === input.user_request);
      if (!testCase) {
        throw new Error(`Could not resolve Braintrust input case for ${input.user_request}`);
      }

      const output = await runCase(testCase, options);
      const currentSpan = (braintrust as any).currentSpan?.();
      const artifacts = currentSpan ? await logExecutionArtifacts(currentSpan, output) : undefined;
      output.execution.artifacts = artifacts;
      currentSpan?.log?.({
        output: {
          case_id: output.case_id,
          summary: output.summary,
          patch: output.patch,
          files_changed: output.files_changed,
          scores: summarizeScores(output.scores)
        },
        metadata: {
          case_id: output.case_id,
          patch_chars: output.patch.length,
          trace: output.agent_trace,
          files_changed: output.files_changed,
          execution_backend: output.execution.backend,
          command_results: output.execution.commands.map((command) => ({
            command: command.command,
            ok: command.ok,
            duration_ms: command.duration_ms,
            exit_code: command.exit_code,
            stdout_excerpt: command.stdout_excerpt,
            stderr_excerpt: command.stderr_excerpt
          })),
          patch_apply: {
            ok: output.execution.patch_apply.ok,
            duration_ms: output.execution.patch_apply.duration_ms,
            exit_code: output.execution.patch_apply.exit_code,
            stderr_excerpt: output.execution.patch_apply.stderr_excerpt
          },
          artifacts,
          ui_health: output.execution.ui_health,
          estimated_cost_usd: output.metrics.estimated_cost_usd,
          estimated_input_tokens: output.metrics.estimated_input_tokens,
          estimated_output_tokens: output.metrics.estimated_output_tokens,
          one_shot_runnable_app: scoreValue(output, "OneShotRunnableApp") === 1
        }
      });
      return output;
    },
    scores: [
      ...deterministicScores.map((name) =>
        namedScore(name, ({ output }) => deterministicScore(output, name))
      ),
      namedScore(
        "RequirementCoverage",
        ({ output, expected }) => {
          const terms = expected.expected_ui_terms;
          const matched = output.execution.ui_health.matched_terms.length;
          const score = terms.length === 0 ? 0 : matched / terms.length;
          return {
            name: "RequirementCoverage",
            score,
            metadata: {
              explanation:
                terms.length === 0
                  ? "RequirementCoverage failed because the dataset case did not define expected UI terms."
                  : `Matched ${matched}/${terms.length} expected UI terms in the built app assets.`,
              expected_terms: terms,
              matched_terms: output.execution.ui_health.matched_terms,
              inspected_files: output.execution.ui_health.inspected_files
            }
          };
        }
      )
    ]
  }, {
    trialCount: 1,
    experimentName: `coding-agent-real-${new Date().toISOString()}`
  });
  await flushBraintrust();
}

export function parseOptions(): RunOptions {
  return {
    mock: process.argv.includes("--mock"),
    caseId: process.argv.find((arg) => arg.startsWith("--case="))?.split("=")[1],
    envFile:
      process.argv.find((arg) => arg.startsWith("--env-file="))?.slice("--env-file=".length) ||
      process.env.ONE_SHOT_DEMO_ENV_FILE,
    localOnly: process.argv.includes("--local")
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseOptions();
  loadEnvFile(options.envFile);
  initDemoLogger();

  if (process.env.BRAINTRUST_API_KEY && !options.localOnly) {
    await runBraintrust(options);
  } else {
    await runLocal(options);
  }
}
