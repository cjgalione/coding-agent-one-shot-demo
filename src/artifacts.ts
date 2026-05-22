import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Attachment } from "braintrust";
import type { EvalOutput } from "./types.js";

const textEncoder = new TextEncoder();
const execFileAsync = promisify(execFile);

function toAttachmentData(text: string) {
  const bytes = textEncoder.encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bufferToAttachmentData(buffer: Buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

async function createRunnableAppBundle(output: EvalOutput, filename: string) {
  if (output.execution.runnable_app_bundle_base64) {
    const data = Buffer.from(output.execution.runnable_app_bundle_base64, "base64");
    return {
      data,
      size_bytes: output.execution.runnable_app_bundle_size_bytes ?? data.length,
      includes_dist: output.execution.ui_health.inspected_files.some((file) =>
        file.startsWith("dist/")
      )
    };
  }

  const bundlePath = path.join(os.tmpdir(), filename);
  await fs.rm(bundlePath, { force: true });
  await execFileAsync("tar", [
    "-czf",
    bundlePath,
    "--exclude",
    "node_modules",
    "--exclude",
    ".git",
    "--exclude",
    ".DS_Store",
    "-C",
    output.execution.workdir,
    "."
  ]);

  const data = await fs.readFile(bundlePath);
  const stat = await fs.stat(bundlePath);
  return {
    data,
    size_bytes: stat.size,
    includes_dist: output.execution.ui_health.inspected_files.some((file) =>
      file.startsWith("dist/")
    )
  };
}

export function buildExecutionArtifact(
  output: EvalOutput,
  artifacts = output.execution.artifacts
) {
  return {
    case_id: output.case_id,
    summary: output.summary,
    headline_score: "OneShotRunnableApp",
    artifacts,
    repo: {
      commit_sha: output.execution.repo_commit_sha,
      url: output.execution.repo_url,
      path: output.execution.repo_path
    },
    files_changed: output.files_changed,
    scores: Object.fromEntries(
      Object.entries(output.scores).map(([name, score]) => [
        name,
        {
          score: score.score,
          metadata: score.metadata ?? {}
        }
      ])
    ),
    metrics: output.metrics,
    execution: {
      backend: output.execution.backend,
      workdir_basename: path.basename(output.execution.workdir),
      duration_ms: output.execution.duration_ms,
      fast_install: output.execution.fast_install,
      patch_apply: output.execution.patch_apply,
      commands: output.execution.commands,
      ui_health: output.execution.ui_health
    },
    agent_trace: output.agent_trace
  };
}

export async function logExecutionArtifacts(span: { log: (event: Record<string, unknown>) => void }, output: EvalOutput) {
  const patchFilename = `${output.case_id}.applied.patch`;
  const reportFilename = `${output.case_id}.execution-report.json`;
  const bundleFilename = `${output.case_id}.runnable-app.tar.gz`;
  const bundle = await createRunnableAppBundle(output, bundleFilename);
  const artifacts = {
    patch_filename: patchFilename,
    report_filename: reportFilename,
    runnable_app_bundle_filename: bundleFilename,
    runnable_app_bundle_format: "tar.gz",
    runnable_app_bundle_size_bytes: bundle.size_bytes
  };
  const report = buildExecutionArtifact(output, artifacts);

  span.log({
    metadata: {
      artifacts,
      runnable_app_bundle: {
        filename: bundleFilename,
        format: "tar.gz",
        size_bytes: bundle.size_bytes,
        includes_dist: bundle.includes_dist,
        run_instructions: [
          "tar -xzf <bundle>.tar.gz",
          "npm install",
          "npm run dev"
        ]
      },
      artifact_files: {
        applied_patch: new Attachment({
          data: toAttachmentData(output.patch),
          filename: patchFilename,
          contentType: "text/x-diff"
        }),
        execution_report: new Attachment({
          data: toAttachmentData(JSON.stringify(report, null, 2)),
          filename: reportFilename,
          contentType: "application/json"
        }),
        runnable_app_bundle: new Attachment({
          data: bufferToAttachmentData(bundle.data),
          filename: bundleFilename,
          contentType: "application/gzip"
        })
      }
    }
  });

  return artifacts;
}
