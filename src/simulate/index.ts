#!/usr/bin/env bun
// `bun run simulate`: a compare run whose Unblocked arm talks to a simulated
// context engine instead of the real service. Same harness, same prompts,
// same analysis; the Unblocked arm's `unblocked` CLI is a local research
// agent (src/engine/). Takes the simulator's flags and YAML fixtures.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { program } from "commander";
import { parse as parseYaml } from "yaml";

import type { Config } from "../types.ts";
import { runBatch } from "../runner.ts";
import { AGENTS, type AgentName } from "../agents/index.ts";

program
  .name("simulate")
  .description("A/B test a coding agent without vs with a simulated Unblocked context engine")
  .option("--fixture <path>", "YAML fixture file with experiment config (flags override it)")
  .option("--repo <path>", "Path to target git repository")
  .option("--task <string>", "Task description for the coding agent")
  .option("--task-file <path>", "File containing the task description")
  .option("--criteria <string>", "Acceptance criteria: the requirement list for the checker and judge")
  .option("--criteria-file <path>", "File containing acceptance criteria")
  .option("--context-instructions <string>", "Extra instructions for every research call")
  .option("--context-instructions-file <path>", "File containing extra research instructions")
  .option("--agent <name>", `Agent CLI under test, also the research agent: ${Object.keys(AGENTS).join(", ")}`)
  .option("--model <model>", "Model for the agent (default: opus for claude; the CLI's configured default for cursor and codex)")
  .option("--context-model <model>", "Model for the research agent (default: same as --model)")
  .option("--context-timeout <seconds>", "Max seconds per research call")
  .option("--timeout <seconds>", "Max seconds per arm")
  .option("--branch <name>", "Branch to base worktrees on (default: current HEAD)")
  .option("--keep-worktrees", "Don't clean up worktrees after run")
  .option("--review", "Requirement-check-and-fix rounds per arm")
  .option("--max-review-rounds <n>", "Cap on review-and-fix rounds when --review is on", "3")
  .option("--repeat <n>", "Full comparisons to run; the batch summary aggregates them")
  .option("--concurrency <n>", "Repeats to run at once", "2")
  .option("--judge-model <model>", "Model for the quality judge and context-impact passes (default: fable)")
  .option("--checker-model <model>", "Model for the requirement check", "sonnet")
  .option("--analyst-model <model>", "Model that labels each message as work/verify/housekeeping", "opus")
  .option("--no-attribution", "Skip the attribution pass (also skips the judge and impact passes)");

program.parse();
const opts = program.opts();

interface Fixture {
  repo?: string; branch?: string; task?: string; criteria?: string; contextInstructions?: string;
  agent?: AgentName; model?: string; contextModel?: string; judgeModel?: string; evalModel?: string;
  timeout?: number; contextTimeout?: number; keepWorktrees?: boolean; review?: boolean; repeat?: number;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

let fixture: Fixture = {};
if (opts.fixture) {
  const file = path.resolve(opts.fixture);
  if (!fs.existsSync(file)) fail(`fixture file not found: ${file}`);
  fixture = (parseYaml(fs.readFileSync(file, "utf-8")) ?? {}) as Fixture;
}

function text(direct: string | undefined, file: string | undefined, fromFixture: string | undefined): string | undefined {
  if (direct) return direct;
  if (file) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) fail(`file not found: ${resolved}`);
    return fs.readFileSync(resolved, "utf-8").trim();
  }
  return fromFixture?.trim() || undefined;
}

const repoRaw = opts.repo ?? fixture.repo;
if (!repoRaw) fail("--repo is required (or set repo in the fixture)");
const repo = path.resolve(repoRaw);
if (!fs.existsSync(repo)) fail(`repo not found: ${repo}`);

const task = text(opts.task, opts.taskFile, fixture.task);
if (!task) fail("--task or --task-file is required (or set task in the fixture)");

const agentName = (opts.agent ?? fixture.agent ?? "claude") as AgentName;
if (!(agentName in AGENTS)) fail(`--agent must be one of ${Object.keys(AGENTS).join(", ")}, got ${JSON.stringify(agentName)}`);
const agent = AGENTS[agentName];

const seconds = (flag: string | undefined, fromFixture: number | undefined, dflt: number, name: string): number => {
  const n = flag !== undefined ? parseInt(flag, 10) : fromFixture ?? dflt;
  if (!Number.isFinite(n) || n <= 0) fail(`${name} must be a positive number of seconds`);
  return n;
};

function currentBranch(): string {
  try { return execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo, stdio: "pipe" }).toString().trim(); } catch { return "HEAD"; }
}

const model = opts.model ?? fixture.model ?? agent.defaultModel;
const review = opts.review ?? fixture.review ?? false;

const config: Config = {
  agent: agent.name,
  repo,
  task,
  criteria: text(opts.criteria, opts.criteriaFile, fixture.criteria),
  model,
  timeoutSeconds: seconds(opts.timeout, fixture.timeout, 5400, "--timeout"),
  branch: opts.branch ?? fixture.branch ?? currentBranch(),
  keepWorktrees: opts.keepWorktrees ?? fixture.keepWorktrees ?? false,
  // The simulated engine is reached through the `unblocked` CLI.
  cliMode: true,
  contextEngine: {
    model: opts.contextModel ?? fixture.contextModel,
    timeoutSeconds: seconds(opts.contextTimeout, fixture.contextTimeout, 300, "--context-timeout"),
    instructions: text(opts.contextInstructions, opts.contextInstructionsFile, fixture.contextInstructions),
  },
  analystModel: opts.attribution === false ? null : opts.analystModel,
  judgeModel: opts.judgeModel ?? fixture.judgeModel ?? fixture.evalModel ?? "fable",
  checkerModel: opts.checkerModel,
  reviewRounds: review ? Math.max(1, parseInt(opts.maxReviewRounds, 10) || 3) : 0,
  repeat: Math.max(1, parseInt(opts.repeat ?? String(fixture.repeat ?? 1), 10) || 1),
  concurrency: Math.max(1, parseInt(opts.concurrency, 10) || 2),
};

runBatch(config).catch((err) => {
  console.error("Simulation failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
