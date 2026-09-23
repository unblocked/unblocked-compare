#!/usr/bin/env bun
// The simulated context engine's `unblocked` CLI. The harness puts a shim for
// it first on the Unblocked arm's PATH, so `unblocked context-research` runs
// here instead of the real service: a read-only research agent (the same CLI
// as the arm, with its MCP servers minus Unblocked) answers the query in the
// original repository and prints results in Unblocked's format.
//
// Configured by the harness through UC_ENGINE_* variables (see shim.ts).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { AGENTS, type AgentName } from "../agents/index.ts";
import { estimateCost } from "../util.ts";
import { fetchUrlsPrompt, researchPrompt, researchSystemPrompt } from "./prompt.ts";
import { parseArgs } from "./args.ts";
import type { EngineCall } from "./shim.ts";

const env = (name: string) => process.env[`UC_ENGINE_${name}`] ?? "";
const dir = env("DIR");
const agent = AGENTS[env("AGENT") as AgentName];
if (!dir || !agent) {
  console.error("unblocked (simulated): not configured; this CLI only runs inside an unblocked-compare simulation.");
  process.exit(2);
}

// Anything this process writes to stderr would land in the calling agent's
// tool result; keep the harness's own logging in a file instead.
const logFile = path.join(dir, "engine.log");
process.stderr.write = ((chunk: string | Uint8Array) => { fs.appendFileSync(logFile, chunk); return true; }) as typeof process.stderr.write;

const USAGE = `Usage:
  unblocked context-research [--effort low|medium|high] --query "<question>"
  unblocked context-get-urls --url <url> [--url <url> ...]`;

function gitStatus(repo: string): string {
  try { return execFileSync("git", ["status", "--porcelain"], { cwd: repo, stdio: "pipe" }).toString(); } catch { return ""; }
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "help" || args.command === "--help" || args.command === "-h" || !args.command) {
  console.log(USAGE);
  process.exit(0);
}
const isResearch = args.command === "context-research";
const isFetch = args.command === "context-get-urls";
if (!isResearch && !isFetch) {
  console.log(`Unknown command "${args.command}". This installation supports context-research and context-get-urls.\n\n${USAGE}`);
  process.exit(1);
}
if ((isResearch && !args.query) || (isFetch && !args.urls.length)) {
  console.log(USAGE);
  process.exit(1);
}

const callsPath = path.join(dir, "calls.jsonl");
const seq = (fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").split("\n").filter(Boolean).length : 0) + 1;
const repo = env("REPO");
const model = env("MODEL") || undefined;
const before = gitStatus(repo);

const run = await agent.run({
  prompt: isResearch ? researchPrompt(args.query) : fetchUrlsPrompt(args.urls),
  appendSystemPrompt: researchSystemPrompt(args.effort, env("INSTRUCTIONS")),
  readOnly: true,
  worktreePath: repo,
  model,
  // The contamination guard for "baseline" kills the research agent if it
  // calls the real Unblocked; blockUnblocked hides it where the CLI can.
  condition: "baseline",
  blockUnblocked: true,
  cliMode: false,
  timeoutMs: (parseInt(env("TIMEOUT"), 10) || 300) * 1000,
  outDir: dir,
  jsonlName: `research-${seq}-${process.pid}.jsonl`,
  env: { ...process.env, PATH: env("PATH") || process.env.PATH },
});

const repoModified = gitStatus(repo) !== before;
const error = run.killedReason ?? (run.exitCode !== 0 ? `exit ${run.exitCode}` : !run.finalResponse.trim() ? "no answer" : undefined);
const call: EngineCall = {
  seq,
  command: args.command,
  ...(isResearch ? { query: args.query, effort: args.effort } : { urls: args.urls }),
  durationMs: run.durationMs,
  costUsd: run.totalCostUsd ?? estimateCost(run.model ?? model ?? "", run.tokenUsage, agent.cacheWriteTier),
  toolCalls: run.toolCalls.length,
  ...(error ? { error } : {}),
  ...(repoModified ? { repoModified: true } : {}),
  transcript: `research-${seq}-${process.pid}.jsonl`,
};
fs.appendFileSync(callsPath, JSON.stringify(call) + "\n");

if (error) {
  console.log(`context-research failed: ${error}`);
  process.exit(1);
}
console.log(run.finalResponse.trim());
