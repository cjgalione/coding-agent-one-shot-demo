import OpenAI from "openai";
import { currentSpan, traced, wrapOpenAI } from "braintrust";
import { z } from "zod";
import type { AgentResult, DatasetCase } from "../types.js";
import { readText, listFiles, loadRelevantFiles, loadSkills } from "../utils/files.js";
import { fromRoot } from "../utils/paths.js";
import { createReplacePatch } from "../utils/diff.js";
import { templateForCase } from "./mock-templates.js";

const FileUpdateSchema = z.object({
  path: z.string(),
  content: z.string(),
  reason: z.string()
});

const AgentResultSchema = z.object({
  summary: z.string(),
  patch: z.string(),
  file_updates: z.array(FileUpdateSchema).optional(),
  files_changed: z.array(z.object({ path: z.string(), reason: z.string() })),
  expected_commands: z.array(z.object({ command: z.string(), purpose: z.string() })),
  agent_trace: z.object({
    skills_used: z.array(z.object({ name: z.string(), reason: z.string() })),
    tools_used: z.array(z.object({ name: z.string(), purpose: z.string() })),
    key_decisions: z.array(z.string()),
    known_risks: z.array(z.string())
  })
});

const ModelBundleResultSchema = z.object({
  summary: z.string(),
  file_updates: z.array(FileUpdateSchema).min(1),
  expected_commands: z.array(z.object({ command: z.string(), purpose: z.string() })),
  agent_trace: z.object({
    skills_used: z.array(z.object({ name: z.string(), reason: z.string() })),
    tools_used: z.array(z.object({ name: z.string(), purpose: z.string() })),
    key_decisions: z.array(z.string()),
    known_risks: z.array(z.string())
  })
});

const ModelBundleJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "file_updates", "expected_commands", "agent_trace"],
  properties: {
    summary: { type: "string" },
    file_updates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content", "reason"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          reason: { type: "string" }
        }
      }
    },
    expected_commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "purpose"],
        properties: {
          command: { type: "string" },
          purpose: { type: "string" }
        }
      }
    },
    agent_trace: {
      type: "object",
      additionalProperties: false,
      required: ["skills_used", "tools_used", "key_decisions", "known_risks"],
      properties: {
        skills_used: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "reason"],
            properties: {
              name: { type: "string" },
              reason: { type: "string" }
            }
          }
        },
        tools_used: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "purpose"],
            properties: {
              name: { type: "string" },
              purpose: { type: "string" }
            }
          }
        },
        key_decisions: { type: "array", items: { type: "string" } },
        known_risks: { type: "array", items: { type: "string" } }
      }
    }
  }
} as const;

export async function renderAgentPrompt(testCase: DatasetCase, wrapperOverride?: string) {
  const wrapper = wrapperOverride ?? (await readText("prompts/task-wrapper.md"));
  const fileTree = (await listFiles(testCase.repo_path)).join("\n");
  const relevantFiles = await loadRelevantFiles(testCase.repo_path);
  const skills = await loadSkills(testCase.skills);
  const constraints = [
    "For this eval harness, return complete updated file contents in file_updates. The harness will generate the unified diff deterministically.",
    "Only include files that should change. Use paths relative to the repository root.",
    "Do not modify package dependencies unless the task requires it.",
    "Keep the app frontend-only for this fixture.",
    `The evaluator starts from repo fixture ${testCase.repo_commit_sha}.`
  ].join("\n");

  return wrapper
    .replace("{{user_request}}", testCase.user_request)
    .replace("{{repo_summary}}", testCase.repo_summary)
    .replace("{{file_tree}}", fileTree)
    .replace("{{relevant_files}}", relevantFiles)
    .replace("{{test_commands}}", testCase.test_commands.join("\n"))
    .replace("{{available_skills}}", skills)
    .replace("{{constraints}}", constraints);
}

async function traceAgentContext(testCase: DatasetCase, model: string, taskPrompt: string) {
  await traced(
    async (span) => {
      const fileTree = await listFiles(testCase.repo_path);
      span.log({
        input: {
          case_id: testCase.id,
          repo_path: testCase.repo_path,
          repo_commit_sha: testCase.repo_commit_sha
        },
        output: {
          repo_summary: testCase.repo_summary,
          file_count: fileTree.length,
          relevant_context_chars: taskPrompt.length,
          test_commands: testCase.test_commands
        },
        metadata: {
          component: "context_builder",
          repo_url: testCase.repo_url,
          expected_ui_terms: testCase.expected_ui_terms
        }
      });
    },
    { name: "build_repo_context" }
  );

  await traced(
    async (span) => {
      span.log({
        input: {
          requested_skills: testCase.skills
        },
        output: {
          available_skills: testCase.skills.map((skill) => ({
            name: skill,
            source: "dataset_case"
          }))
        },
        metadata: {
          component: "skill_loader",
          skill_count: testCase.skills.length
        }
      });
    },
    { name: "load_available_skills" }
  );

  await traced(
    async (span) => {
      span.log({
        input: {
          requested_model: testCase.agent_config.model,
          requested_mcp_servers: testCase.agent_config.mcp_servers
        },
        output: {
          primary_agent: {
            name: "AppPatch Agent",
            model,
            role: "one-shot app builder"
          },
          possible_sub_agents: [
            {
              name: "ui_implementer",
              status: "not_spawned",
              reason: "Current demo uses a single no-nonsense coding agent, but traces reserve topology for future delegation."
            },
            {
              name: "test_writer",
              status: "not_spawned",
              reason: "The primary agent is responsible for updating tests in this minimal harness."
            },
            {
              name: "execution_scorer",
              status: "external_backend",
              reason: "Execution is handled by the scorer/backend rather than a model sub-agent."
            }
          ]
        },
        metadata: {
          component: "agent_orchestrator",
          agent_count: 1,
          possible_sub_agent_count: 3,
          mcp_servers: testCase.agent_config.mcp_servers
        }
      });
    },
    { name: "agent_topology" }
  );
}

async function traceReportedAgentTrace(agentTrace: AgentResult["agent_trace"]) {
  await traced(
    async (span) => {
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
      async (span) => {
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
    async (span) => {
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
      async (span) => {
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
    async (span) => {
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

export async function runCodingAgent(
  testCase: DatasetCase,
  options: {
    mock?: boolean;
    systemPrompt?: string;
    taskWrapperPrompt?: string;
    model?: string;
  } = {}
): Promise<AgentResult> {
  return traced(
    async (span) => {
      span.log({
        input: {
          case_id: testCase.id,
          user_request: testCase.user_request,
          repo_commit_sha: testCase.repo_commit_sha,
          repo_path: testCase.repo_path,
          skills: testCase.skills,
          mock: Boolean(options.mock)
        },
        metadata: {
          component: "coding_agent",
          one_shot_flow: "prompt_plus_repo_sha_to_patch"
        }
      });

      if (options.mock) {
        const mockResult = await traced(() => runMockAgent(testCase), {
          name: "mock_patch_generator"
        });
        span.log({
          output: {
            summary: mockResult.summary,
            files_changed: mockResult.files_changed,
            patch_chars: mockResult.patch.length
          }
        });
        return mockResult;
      }

      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is required unless --mock is passed.");
      }

      const systemPrompt = options.systemPrompt ?? (await readText("prompts/system.md"));
      const taskPrompt = await traced(() => renderAgentPrompt(testCase, options.taskWrapperPrompt), {
        name: "render_task_prompt"
      });
      const model = options.model || resolveModel(testCase);
      await traceAgentContext(testCase, model, taskPrompt);
      const started = Date.now();
      const client = wrapOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

      const modelResult = await traced(
        () => callCodingModel(client as OpenAI, model, systemPrompt, taskPrompt, testCase),
        {
          name: "call_coding_model",
          event: {
            metadata: {
              model,
              api: usesResponsesApi(model) ? "responses" : "chat_completions"
            }
          }
        }
      );

      const parsed = ModelBundleResultSchema.parse(parseJsonObject(modelResult.content));
      const patch = await traced(
        () =>
          createReplacePatch(
            fromRoot(testCase.repo_path),
            Object.fromEntries(parsed.file_updates.map((update) => [update.path, update.content]))
          ),
        {
          name: "generate_unified_patch",
          event: {
            metadata: {
              component: "harness_diff_generator",
              file_update_count: parsed.file_updates.length,
              files_changed: parsed.file_updates.map((update) => update.path)
            }
          }
        }
      );
      const agentTrace = normalizeTrace(parsed.agent_trace, testCase);
      await traceReportedAgentTrace(agentTrace);
      const result = {
        summary: parsed.summary,
        patch,
        file_updates: parsed.file_updates,
        files_changed: parsed.file_updates.map((update) => ({
          path: update.path,
          reason: update.reason
        })),
        expected_commands: parsed.expected_commands,
        agent_trace: agentTrace,
        estimated_tokens: {
          input: modelResult.inputTokens ?? estimateTokens(systemPrompt + taskPrompt),
          output: modelResult.outputTokens ?? estimateTokens(modelResult.content)
        },
        estimated_cost_usd: estimateCostUsd(
          modelResult.inputTokens ?? estimateTokens(systemPrompt + taskPrompt),
          modelResult.outputTokens ?? estimateTokens(modelResult.content)
        ) + (Date.now() - started) * 0
      };

      currentSpan().log({
        output: {
          summary: result.summary,
          files_changed: result.files_changed,
          patch_chars: result.patch.length
        },
        metadata: {
          response_id: modelResult.responseId,
          model,
          agent_name: "AppPatch Agent",
          skills_used: result.agent_trace.skills_used,
          tools_used: result.agent_trace.tools_used,
          possible_sub_agents: ["ui_implementer", "test_writer", "execution_scorer"],
          estimated_input_tokens: result.estimated_tokens.input,
          estimated_output_tokens: result.estimated_tokens.output,
          estimated_cost_usd: result.estimated_cost_usd
        }
      });

      return result;
    },
    { name: "AppPatch Agent" }
  );
}

function normalizeTrace(
  trace: z.infer<typeof ModelBundleResultSchema>["agent_trace"],
  testCase: DatasetCase
) {
  return {
    skills_used:
      trace.skills_used.length > 0
        ? trace.skills_used
        : testCase.skills.map((skill) => ({
            name: skill,
            reason: "Included in the case input and considered by the coding agent."
          })),
    tools_used:
      trace.tools_used.length > 0
        ? trace.tools_used
        : [
            {
              name: "model_file_update",
              purpose: "Returned complete updated file contents for the harness to diff."
            },
            {
              name: "harness_diff_generator",
              purpose: "Converted model file updates into a unified diff."
            }
          ],
    key_decisions:
      trace.key_decisions.length > 0
        ? trace.key_decisions
        : ["Generated a small frontend-only vertical slice against the existing Vite React fixture."],
    known_risks: Array.isArray(trace.known_risks) ? trace.known_risks : []
  };
}

export async function runMockAgent(testCase: DatasetCase): Promise<AgentResult> {
  const template = templateForCase(testCase);
  const patch = await createReplacePatch(fromRoot(testCase.repo_path), {
    "src/App.tsx": template.app,
    "src/App.css": template.css,
    "src/App.test.tsx": template.test
  });

  return {
    summary: template.summary,
    patch,
    files_changed: [
      { path: "src/App.tsx", reason: "Replace the placeholder with the requested app workflow." },
      { path: "src/App.css", reason: "Add responsive operational dashboard styles." },
      { path: "src/App.test.tsx", reason: "Cover the primary user flow for the generated app." }
    ],
    expected_commands: [
      { command: "npm install", purpose: "install" },
      { command: "npm run build", purpose: "build" },
      { command: "npm test", purpose: "test" },
      { command: "npm run start:check", purpose: "start" }
    ],
    agent_trace: {
      skills_used: testCase.skills.map((skill) => ({
        name: skill,
        reason: "Applied fixture-specific UI, data, and testing guidance."
      })),
      tools_used: [
        { name: "file_reader", purpose: "Read the fixture package, app, styles, and tests." },
        { name: "patch_generator", purpose: "Generated a unified diff against the fixture repo state." }
      ],
      key_decisions: template.decisions,
      known_risks: template.risks
    },
    estimated_tokens: {
      input: 2800,
      output: 1900
    },
    estimated_cost_usd: 0.02
  };
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function estimateCostUsd(inputTokens: number, outputTokens: number) {
  const inputPerMillion = 3;
  const outputPerMillion = 15;
  return (inputTokens / 1_000_000) * inputPerMillion + (outputTokens / 1_000_000) * outputPerMillion;
}

function resolveModel(testCase: DatasetCase) {
  const configured = testCase.agent_config.model;
  const fallback = configured.includes("|") ? configured.split("|")[1] : "gpt-5.2-codex";
  return process.env.CODING_AGENT_MODEL || fallback || "gpt-5.2-codex";
}

function usesResponsesApi(model: string) {
  return model.includes("codex") || model.startsWith("gpt-5");
}

async function callCodingModel(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  taskPrompt: string,
  testCase: DatasetCase
) {
  if (usesResponsesApi(model)) {
    const response = await client.responses.create({
      model,
      instructions: systemPrompt,
      input: taskPrompt,
      text: {
        format: {
          type: "json_schema",
          name: "app_patch_agent_result",
          strict: true,
          schema: ModelBundleJsonSchema
        }
      },
      reasoning: { effort: "medium" }
    } as any);

    if (!response.output_text) {
      throw new Error(`Coding model returned no output text. Status: ${response.status}`);
    }

    return {
      content: response.output_text,
      responseId: response.id,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens
    };
  }

  const response = await client.chat.completions.create({
    model,
    temperature: testCase.agent_config.temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: taskPrompt }
    ]
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Coding model returned an empty response.");
  }

  return {
    content,
    responseId: response.id,
    inputTokens: response.usage?.prompt_tokens,
    outputTokens: response.usage?.completion_tokens
  };
}

function parseJsonObject(content: string) {
  try {
    return JSON.parse(content);
  } catch {
    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error("Coding model output was not JSON.");
    }
    return JSON.parse(content.slice(firstBrace, lastBrace + 1));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { loadEnvFile } = await import("../utils/env.js");
  const { readJson } = await import("../utils/files.js");
  const envFile = process.argv.find((arg) => arg.startsWith("--env-file="))?.slice("--env-file=".length);
  loadEnvFile(envFile);
  const cases = await readJson<DatasetCase[]>("data/cases.json");
  const caseId = process.argv.find((arg) => arg.startsWith("--case="))?.split("=")[1];
  const testCase = cases.find((candidate) => candidate.id === caseId) ?? cases[0];
  const result = await runCodingAgent(testCase, { mock: process.argv.includes("--mock") });
  const outputJson = `${JSON.stringify(result, null, 2)}\n`;
  const outPath =
    process.argv.find((arg) => arg.startsWith("--out="))?.slice("--out=".length) ??
    `results/${testCase.id}.agent-result.json`;
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, outputJson);
  process.stdout.write(outputJson);
  process.stderr.write(`Saved agent result to ${outPath}\n`);
}
