import braintrust from "braintrust";
import { z } from "zod";

const project = braintrust.projects.create({
  name: process.env.BRAINTRUST_PROJECT_NAME ?? "coding-agent-one-shot-demo"
});

const scorerParams = z.object({
  input: z.unknown().optional(),
  output: z.unknown(),
  expected: z.unknown().optional(),
  metadata: z.record(z.unknown()).optional()
});

type ScoreReturn = {
  name: string;
  score: number;
  metadata: Record<string, unknown>;
};

type CommandLike = {
  command?: string;
  ok?: boolean;
  exit_code?: number | null;
  duration_ms?: number;
  stdout_excerpt?: string;
  stderr_excerpt?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampScore(value: unknown): number {
  const numeric = asNumber(value);
  if (numeric === undefined) {
    return 0;
  }
  return Math.max(0, Math.min(1, numeric));
}

function existingScore(output: unknown, name: string): ScoreReturn | undefined {
  const scores = asRecord(asRecord(output).scores);
  const result = asRecord(scores[name]);
  const score = asNumber(result.score);
  if (score === undefined) {
    return undefined;
  }
  return {
    name,
    score: clampScore(score),
    metadata: asRecord(result.metadata)
  };
}

function missingScore(name: string): ScoreReturn {
  return {
    name,
    score: 0,
    metadata: {
      explanation: `${name} failed because the execution report did not include that score.`
    }
  };
}

function fromExecutionScore(output: unknown, name: string): ScoreReturn {
  return existingScore(output, name) ?? missingScore(name);
}

function execution(output: unknown): Record<string, unknown> {
  return asRecord(asRecord(output).execution);
}

function commandEvidence(command: unknown): Record<string, unknown> {
  const result = asRecord(command) as CommandLike;
  return {
    command: result.command,
    ok: result.ok,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    stdout_excerpt: result.stdout_excerpt,
    stderr_excerpt: result.stderr_excerpt
  };
}

function commandByPattern(output: unknown, pattern: RegExp): CommandLike | undefined {
  const commands = execution(output).commands;
  if (!Array.isArray(commands)) {
    return undefined;
  }
  return commands
    .map((command) => asRecord(command) as CommandLike)
    .find((command) => pattern.test(command.command ?? ""));
}

function fallbackCommandScore(output: unknown, name: string, pattern: RegExp): ScoreReturn {
  const existing = existingScore(output, name);
  if (existing) {
    return existing;
  }

  const command = commandByPattern(output, pattern);
  if (!command) {
    return missingScore(name);
  }

  return {
    name,
    score: command.ok ? 1 : 0,
    metadata: {
      explanation: command.ok
        ? `${name} passed because the command succeeded.`
        : `${name} failed because the command failed.`,
      ...commandEvidence(command)
    }
  };
}

function patchApplies(output: unknown): ScoreReturn {
  const existing = existingScore(output, "PatchApplies");
  if (existing) {
    return existing;
  }

  const patchApply = execution(output).patch_apply;
  const result = asRecord(patchApply) as CommandLike;
  if (!patchApply) {
    return missingScore("PatchApplies");
  }

  return {
    name: "PatchApplies",
    score: result.ok ? 1 : 0,
    metadata: {
      explanation: result.ok
        ? "PatchApplies passed because the generated patch applied cleanly."
        : "PatchApplies failed because the generated patch did not apply cleanly.",
      ...commandEvidence(result)
    }
  };
}

function traceCompleteness(output: unknown): ScoreReturn {
  const existing = existingScore(output, "TraceCompleteness");
  if (existing) {
    return existing;
  }

  const trace = asRecord(asRecord(output).agent_trace);
  const skills = Array.isArray(trace.skills_used) ? trace.skills_used.length : 0;
  const tools = Array.isArray(trace.tools_used) ? trace.tools_used.length : 0;
  const decisions = Array.isArray(trace.key_decisions) ? trace.key_decisions.length : 0;
  const risks = Array.isArray(trace.known_risks) ? trace.known_risks.length : 0;
  const complete = skills > 0 && tools > 0 && decisions > 0 && risks >= 0;

  return {
    name: "TraceCompleteness",
    score: complete ? 1 : 0,
    metadata: {
      explanation: complete
        ? "TraceCompleteness passed because the agent reported skills, tools, and key decisions."
        : "TraceCompleteness failed because required trace fields were missing or empty.",
      skills_used_count: skills,
      tools_used_count: tools,
      key_decisions_count: decisions,
      known_risks_count: risks
    }
  };
}

function requirementCoverage(output: unknown, expected: unknown): ScoreReturn {
  const expectedTerms = asRecord(expected).expected_ui_terms;
  const terms = Array.isArray(expectedTerms) ? expectedTerms.filter((term) => typeof term === "string") : [];
  const uiHealth = asRecord(execution(output).ui_health);
  const matchedTerms = Array.isArray(uiHealth.matched_terms)
    ? uiHealth.matched_terms.filter((term) => typeof term === "string")
    : [];
  const inspectedFiles = Array.isArray(uiHealth.inspected_files)
    ? uiHealth.inspected_files.filter((file) => typeof file === "string")
    : [];

  return {
    name: "RequirementCoverage",
    score: terms.length === 0 ? 0 : matchedTerms.length / terms.length,
    metadata: {
      explanation:
        terms.length === 0
          ? "RequirementCoverage failed because no expected UI terms were provided."
          : `Matched ${matchedTerms.length}/${terms.length} expected UI terms in built app assets.`,
      expected_terms: terms,
      matched_terms: matchedTerms,
      inspected_files: inspectedFiles
    }
  };
}

function oneShotRunnableApp(output: unknown): ScoreReturn {
  const existing = existingScore(output, "OneShotRunnableApp");
  if (existing) {
    return existing;
  }

  const checks = {
    PatchApplies: patchApplies(output),
    InstallSucceeds: fallbackCommandScore(output, "InstallSucceeds", /npm install/),
    BuildSucceeds: fallbackCommandScore(output, "BuildSucceeds", /npm run build/),
    TestsPass: fallbackCommandScore(output, "TestsPass", /npm test/),
    AppStarts: fallbackCommandScore(output, "AppStarts", /npm run start:check/),
    BasicUIHealth: fromExecutionScore(output, "BasicUIHealth"),
    TraceCompleteness: traceCompleteness(output)
  };
  const passed = Object.values(checks).every((result) => result.score === 1);

  return {
    name: "OneShotRunnableApp",
    score: passed ? 1 : 0,
    metadata: {
      explanation: passed
        ? "OneShotRunnableApp passed because patch, install, build, tests, start, UI health, and trace completeness all passed."
        : "OneShotRunnableApp failed because at least one required execution-backed check failed.",
      component_scores: Object.fromEntries(
        Object.entries(checks).map(([name, result]) => [name, result.score])
      )
    }
  };
}

const scoreDefinitions: Array<{
  name: string;
  slug: string;
  description: string;
  passThreshold: number;
  handler: (args: z.infer<typeof scorerParams>) => ScoreReturn;
}> = [
  {
    name: "OneShotRunnableApp",
    slug: "one-shot-runnable-app",
    description:
      "Composite pass/fail check for whether the agent one-shot produced a runnable app: patch, install, build, tests, start, UI health, and trace completeness.",
    passThreshold: 1,
    handler: ({ output }) => oneShotRunnableApp(output)
  },
  {
    name: "PatchApplies",
    slug: "patch-applies",
    description: "Checks whether the generated patch applied cleanly to the requested repo state.",
    passThreshold: 1,
    handler: ({ output }) => patchApplies(output)
  },
  {
    name: "InstallSucceeds",
    slug: "install-succeeds",
    description: "Checks whether dependency installation succeeded in the execution backend.",
    passThreshold: 1,
    handler: ({ output }) => fallbackCommandScore(output, "InstallSucceeds", /npm install/)
  },
  {
    name: "BuildSucceeds",
    slug: "build-succeeds",
    description: "Checks whether the patched app built successfully.",
    passThreshold: 1,
    handler: ({ output }) => fallbackCommandScore(output, "BuildSucceeds", /npm run build/)
  },
  {
    name: "TestsPass",
    slug: "tests-pass",
    description: "Checks whether the patched app's test command passed.",
    passThreshold: 1,
    handler: ({ output }) => fallbackCommandScore(output, "TestsPass", /npm test/)
  },
  {
    name: "AppStarts",
    slug: "app-starts",
    description: "Checks whether the patched app passed the start-check command.",
    passThreshold: 1,
    handler: ({ output }) => fallbackCommandScore(output, "AppStarts", /npm run start:check/)
  },
  {
    name: "BasicUIHealth",
    slug: "basic-ui-health",
    description: "Checks whether the built app contains task-relevant UI terms and is not blank.",
    passThreshold: 1,
    handler: ({ output }) => fromExecutionScore(output, "BasicUIHealth")
  },
  {
    name: "TraceCompleteness",
    slug: "trace-completeness",
    description: "Checks whether the coding agent returned useful trace metadata.",
    passThreshold: 1,
    handler: ({ output }) => traceCompleteness(output)
  },
  {
    name: "RequirementCoverage",
    slug: "requirement-coverage",
    description: "Scores how many expected UI terms are present in the built app assets.",
    passThreshold: 0.75,
    handler: ({ output, expected }) => requirementCoverage(output, expected)
  }
];

for (const definition of scoreDefinitions) {
  project.scorers.create({
    name: definition.name,
    slug: definition.slug,
    description: definition.description,
    parameters: scorerParams,
    handler: definition.handler,
    metadata: {
      __pass_threshold: definition.passThreshold
    },
    ifExists: "replace"
  });
}
