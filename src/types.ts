export type AgentConfig = {
  model: string;
  temperature: number;
  mcp_servers: string[];
};

export type DatasetCase = {
  id: string;
  user_request: string;
  repo_commit_sha: string;
  repo_path: string;
  repo_summary: string;
  skills: string[];
  agent_config: AgentConfig;
  test_commands: string[];
  expected_ui_terms: string[];
};

export type AgentTrace = {
  skills_used: Array<{ name: string; reason: string }>;
  tools_used: Array<{ name: string; purpose: string }>;
  key_decisions: string[];
  known_risks: string[];
};

export type AgentResult = {
  summary: string;
  patch: string;
  file_updates?: Array<{
    path: string;
    content: string;
    reason: string;
  }>;
  files_changed: Array<{ path: string; reason: string }>;
  expected_commands: Array<{ command: string; purpose: string }>;
  agent_trace: AgentTrace;
  estimated_tokens?: {
    input: number;
    output: number;
  };
  estimated_cost_usd?: number;
};

export type CommandResult = {
  command: string;
  ok: boolean;
  duration_ms: number;
  timeout_ms?: number;
  stdout: string;
  stderr: string;
  stdout_excerpt: string;
  stderr_excerpt: string;
  exit_code: number | null;
  execution_mode?: string;
};

export type ScoreResult = {
  name: string;
  score: number;
  metadata?: Record<string, unknown>;
};

export type ExecutionReport = {
  backend: string;
  workdir: string;
  repo_commit_sha: string;
  repo_path: string;
  fast_install: boolean;
  duration_ms: number;
  scores: Record<string, ScoreResult>;
  patch_apply: CommandResult;
  commands: CommandResult[];
  ui_health: {
    checked_terms: string[];
    matched_terms: string[];
    inspected_files: string[];
  };
  artifacts?: {
    patch_filename: string;
    report_filename: string;
    runnable_app_bundle_filename?: string;
    runnable_app_bundle_format?: string;
    runnable_app_bundle_size_bytes?: number;
  };
};

export type EvalOutput = {
  case_id: string;
  summary: string;
  patch: string;
  files_changed: AgentResult["files_changed"];
  agent_trace: AgentTrace;
  scores: Record<string, ScoreResult>;
  metrics: {
    duration_ms: number;
    estimated_input_tokens: number;
    estimated_output_tokens: number;
    estimated_cost_usd: number;
  };
  execution: Omit<ExecutionReport, "scores">;
};
