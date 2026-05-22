import { Eval, currentSpan } from "braintrust";
import { z } from "zod";
import { readFileSync } from "node:fs";
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

const defaultSystemPrompt = readFileSync("prompts/system.md", "utf8");
const defaultTaskWrapperPrompt = readFileSync("prompts/task-wrapper.md", "utf8");

type PromptParamValue = {
  prompt?: string;
  content?: string;
  messages?: Array<{
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  }>;
  model?: string;
};

function promptParameter({
  messages,
  model,
  description
}: {
  messages: PromptParamValue["messages"];
  model: string;
  description: string;
}) {
  return {
    type: "prompt",
    description,
    default: {
      messages,
      model
    }
  } as const;
}

function promptTextFromParameter(param: unknown, fallback: string) {
  const value = param as PromptParamValue | undefined;

  if (typeof value?.prompt === "string" && value.prompt.trim()) {
    return value.prompt;
  }
  if (typeof value?.content === "string" && value.content.trim()) {
    return value.content;
  }

  const messages = value?.messages ?? [];
  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string" && content.trim()) {
      return content;
    }
    if (Array.isArray(content)) {
      const text = content
        .map((part) => part.text)
        .filter((part): part is string => Boolean(part?.trim()))
        .join("\n");
      if (text.trim()) {
        return text;
      }
    }
  }

  return fallback;
}

function modelFromPromptParameter(param: unknown, fallback: string) {
  const value = param as PromptParamValue | undefined;
  return value?.model || fallback;
}

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
    app_patch_agent_prompt: promptParameter({
      messages: [{ role: "system", content: defaultSystemPrompt }],
      model: "gpt-5.2-codex",
      description: "AppPatch Agent system prompt plus model."
    }),
    task_wrapper_prompt: promptParameter({
      messages: [{ role: "user", content: defaultTaskWrapperPrompt }],
      model: "gpt-5.2-codex",
      description: "Template that wraps each input row into the coding-agent task prompt."
    }),
    implementation_guidance: z
      .string()
      .default("Prefer a small, working one-shot app over an ambitious broken implementation.")
      .describe("Additional implementation guidance appended to the task prompt for prompt-variant experiments.")
  },
  task: async (input, hooks) => {
    const params = hooks.parameters;
    const codingModel = modelFromPromptParameter(params.app_patch_agent_prompt, "gpt-5.2-codex");
    const systemPrompt = promptTextFromParameter(params.app_patch_agent_prompt, defaultSystemPrompt);
    const taskWrapperPrompt = promptTextFromParameter(params.task_wrapper_prompt, defaultTaskWrapperPrompt);
    const output = await withTemporaryEnv(
      {
        CODING_AGENT_MODEL: codingModel,
        ONE_SHOT_EXECUTION_BACKEND: "local",
        ONE_SHOT_DEMO_FAST_INSTALL: "1",
        ONE_SHOT_DEMO_REQUIRE_LISTEN: undefined
      },
      () =>
        runCase(inputToCase(input), {
          mock: false,
          localOnly: false,
          agent: {
            model: codingModel,
            systemPrompt,
            taskWrapperPrompt: `${taskWrapperPrompt}\n\nADDITIONAL_IMPLEMENTATION_GUIDANCE:\n${params.implementation_guidance}`
          }
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
