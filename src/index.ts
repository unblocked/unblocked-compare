#!/usr/bin/env bun
import { execSync } from "node:child_process";
import { program } from "commander";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./types.ts";
import { runBatch } from "./runner.ts";

function getCurrentBranch(repoPath: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath, stdio: "pipe" }).toString().trim();
  } catch {
    return "HEAD";
  }
}

program
  .name("claude-harness")
  .description("A/B comparison: Claude Code agent with vs without Unblocked context")
  .requiredOption("--repo <path>", "Path to target git repository")
  .requiredOption("--task <string>", "Task description for the agent")
  .option("--model <model>", "Model for Claude to use", "opus")
  .option("--timeout <seconds>", "Max seconds per arm (shared across the draft and every review fix pass)", "5400")
  .option("--branch <name>", "Branch to base worktree on (default: current HEAD)")
  .option("--keep-worktrees", "Don't clean up worktrees after run", false)
  .option("--cli", "Use Unblocked CLI via Bash tool instead of MCP", false)
  .option("--analyst-model <model>", "Model that labels each message as work/verify/housekeeping", "opus")
  .option("--judge-model <model>", "Model for the quality judge and context-impact passes", "fable")
  .option("--checker-model <model>", "Model for the requirement check: extracts the list, classifies each requirement per round, adjudicates disputes", "sonnet")
  .option("--no-attribution", "Skip the per-turn attribution pass")
  .option("--review", "Requirement-check-and-fix rounds per arm until every task requirement is met, or the cap", false)
  .option("--max-review-rounds <n>", "Cap on review-and-fix rounds when --review is on", "3")
  .option("--repeat <n>", "Full comparisons to run for this task; the batch summary aggregates them", "2")
  .option("--concurrency <n>", "Repeats to run at once", "2");

program.parse();
const opts = program.opts();

const repoPath = path.resolve(opts.repo);
if (!fs.existsSync(repoPath)) {
  console.error(`Error: repo not found: ${repoPath}`);
  process.exit(1);
}

const timeoutSeconds = parseInt(opts.timeout, 10);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error(`Error: --timeout must be a positive number of seconds, got ${JSON.stringify(opts.timeout)}`);
  process.exit(1);
}

const config: Config = {
  repo: repoPath,
  task: opts.task,
  model: opts.model,
  timeoutSeconds,
  branch: opts.branch ?? getCurrentBranch(repoPath),
  keepWorktrees: opts.keepWorktrees,
  cliMode: opts.cli,
  analystModel: opts.attribution === false ? null : opts.analystModel,
  judgeModel: opts.judgeModel,
  checkerModel: opts.checkerModel,
  reviewRounds: opts.review ? Math.max(1, parseInt(opts.maxReviewRounds, 10) || 3) : 0,
  repeat: Math.max(1, parseInt(opts.repeat, 10) || 2),
  concurrency: Math.max(1, parseInt(opts.concurrency, 10) || 2),
};

runBatch(config).catch((err) => {
  console.error("Run failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
