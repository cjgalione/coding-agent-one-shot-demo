import { Eval, currentSpan } from "braintrust";
import { z } from "zod";
import type { DatasetCase, EvalOutput, ScoreResult } from "../src/types.js";
import {
  deterministicScore,
  deterministicScores,
  namedScore,
  runCase,
  summarizeScores
} from "../src/eval.js";
import { logExecutionArtifacts } from "../src/artifacts.js";
import { readJson } from "../src/utils/files.js";
import { loadEnvFile } from "../src/utils/env.js";

const defaultModalScorerUrl =
  "https://curtis-41436--coding-agent-one-shot-modal-scorer-scorer-app.modal.run";

type OneShotInput = {
  case_id: string;
  user_request: string;
  repo_url?: string;
  repo_commit_sha: string;
  repo_path: string;
  skills: string[];
  agent_config: DatasetCase["agent_config"];
  test_commands: string[];
  expected_ui_terms: string[];
};

function requirementCoverage({ output, expected }: {
  output: EvalOutput;
  expected?: { expected_ui_terms: string[] };
}): ScoreResult {
  const terms = expected?.expected_ui_terms ?? [];
  const matched = output.execution.ui_health.matched_terms.length;
  const score = terms.length === 0 ? 0 : matched / terms.length;
  return {
    name: "RequirementCoverage",
    score,
    metadata: {
      explanation:
        terms.length === 0
          ? "RequirementCoverage failed because the input did not define expected UI terms."
          : `Matched ${matched}/${terms.length} expected UI terms in the built app assets.`,
      expected_terms: terms,
      matched_terms: output.execution.ui_health.matched_terms,
      inspected_files: output.execution.ui_health.inspected_files
    }
  };
}

async function defaultInput(): Promise<OneShotInput> {
  const cases = await readJson<DatasetCase[]>("data/cases.json");
  const testCase = cases.find((candidate) => candidate.id === "inventory-dashboard-001") ?? cases[0];
  return {
    case_id: testCase.id,
    user_request: testCase.user_request,
    repo_url: testCase.repo_url,
    repo_commit_sha: testCase.repo_commit_sha,
    repo_path: testCase.repo_path,
    skills: testCase.skills,
    agent_config: testCase.agent_config,
    test_commands: testCase.test_commands,
    expected_ui_terms: testCase.expected_ui_terms
  };
}

function inputToCase(input: OneShotInput): DatasetCase {
  return {
    id: input.case_id,
    user_request: input.user_request,
    repo_url: input.repo_url,
    repo_commit_sha: input.repo_commit_sha,
    repo_path: input.repo_path,
    repo_summary: "A minimal Vite React app that currently renders a placeholder page.",
    skills: input.skills,
    agent_config: input.agent_config,
    test_commands: input.test_commands,
    expected_ui_terms: input.expected_ui_terms
  };
}

function withTemporaryEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>) {
  const previous = Object.fromEntries(
    Object.keys(updates).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return run().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

loadEnvFile(process.env.ONE_SHOT_DEMO_ENV_FILE);

Eval<OneShotInput, EvalOutput, { expected_ui_terms: string[] }>(
  "One Shot Coding Agent - Remote Execution",
  {
  data: async () => {
    const input = await defaultInput();
    return [
      {
        input,
        expected: {
          expected_ui_terms: input.expected_ui_terms
        },
        metadata: {
          case_id: input.case_id,
          ui_demo: true,
          one_shot_flow: "prompt_plus_repo_sha_to_patch_to_modal_remote_execution"
        }
      }
    ];
  },
  parameters: {
    coding_model: z
      .string()
      .default("gpt-5.2-codex")
      .describe("Coding model used by AppPatch Agent when mock_agent is false."),
    mock_agent: z
      .boolean()
      .default(false)
      .describe("Use the deterministic mock patch generator instead of calling the coding model."),
    execution_backend: z
      .enum(["modal", "local"])
      .default("modal")
      .describe("Where the scorer applies the patch and runs install/build/test/start/UI checks."),
    modal_scorer_url: z
      .string()
      .default(defaultModalScorerUrl)
      .describe("Modal FastAPI endpoint used when execution_backend is modal."),
    fast_install: z
      .boolean()
      .default(true)
      .describe("Local backend only: link node_modules for speed. Set false for strict npm install."),
    require_listen: z
      .boolean()
      .default(false)
      .describe("Require the start-check server to bind a localhost port instead of allowing static fallback.")
  },
  task: async (input, hooks) => {
    const params = hooks.parameters;
    const output = await withTemporaryEnv(
      {
        CODING_AGENT_MODEL: params.coding_model,
        ONE_SHOT_EXECUTION_BACKEND: params.execution_backend,
        MODAL_SCORER_URL:
          params.execution_backend === "modal" ? params.modal_scorer_url : process.env.MODAL_SCORER_URL,
        ONE_SHOT_DEMO_FAST_INSTALL: params.fast_install ? "1" : "0",
        ONE_SHOT_DEMO_REQUIRE_LISTEN: params.require_listen ? "1" : undefined
      },
      () =>
        runCase(inputToCase(input), {
          mock: params.mock_agent,
          localOnly: false
        })
    );

    const artifacts = await logExecutionArtifacts(currentSpan(), output);
    output.execution.artifacts = artifacts;
    hooks.metadata.execution_backend = output.execution.backend;
    hooks.metadata.one_shot_runnable_app = output.scores.OneShotRunnableApp?.score === 1;
    hooks.metadata.artifacts = artifacts;

    currentSpan().log({
      output: {
        case_id: output.case_id,
        summary: output.summary,
        patch: output.patch,
        files_changed: output.files_changed,
        scores: summarizeScores(output.scores)
      },
      metadata: {
        patch_chars: output.patch.length,
        trace: output.agent_trace,
        command_results: output.execution.commands.map((command) => ({
          command: command.command,
          ok: command.ok,
          duration_ms: command.duration_ms,
          exit_code: command.exit_code,
          stdout_excerpt: command.stdout_excerpt,
          stderr_excerpt: command.stderr_excerpt
        })),
        ui_health: output.execution.ui_health,
        artifacts
      }
    });

    return output;
  },
  scores: [
    ...deterministicScores.map((name) =>
      namedScore(name, ({ output }) => deterministicScore(output, name))
    ),
    namedScore("RequirementCoverage", requirementCoverage)
  ],
  experimentName: `one-shot-remote-ui-${new Date().toISOString()}`,
  trialCount: 1
  }
);
