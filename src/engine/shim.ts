// Wiring for the simulated context engine: an `unblocked` shim first on the
// Unblocked arm's PATH, the UC_ENGINE_* variables that configure cli.ts, and
// reading back the calls it logged.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentName } from "../agents/types.ts";
import { noPushEnv } from "../worktree.ts";

export interface ContextEngineConfig {
  // Research agent's model; defaults to the arm's.
  model?: string;
  // Budget for one research call, seconds.
  timeoutSeconds: number;
  // Extra instructions for every research call.
  instructions?: string;
}

export interface EngineCall {
  seq: number;
  command: string;
  query?: string;
  effort?: string;
  urls?: string[];
  durationMs: number;
  costUsd: number;
  toolCalls: number;
  error?: string;
  // The research agent changed the repository it was told not to touch.
  repoModified?: boolean;
  transcript: string;
}

export interface EngineSummary {
  calls: EngineCall[];
  costUsd: number;
  durationMs: number;
  // Research time removed from the arm's timings (each call counts as at most
  // capMs), and that cap.
  discountedMs?: number;
  capMs?: number;
}

const CLI = path.join(import.meta.dir, "cli.ts");

export function engineDir(armOutDir: string): string {
  return path.join(armOutDir, "engine");
}

// The Unblocked arm's environment and the shim to call. Agents run commands
// through login shells that reorder PATH, so the arm is told the shim's
// absolute path rather than relying on PATH. It lives in the temp dir, under a
// name without "unblocked", so the path neither contains spaces nor gives the
// blinded judge a hint.
export function engineEnv(opts: { armOutDir: string; agent: AgentName; model?: string; repo: string; engine: ContextEngineConfig }): { env: NodeJS.ProcessEnv; command: string } {
  const dir = engineDir(opts.armOutDir);
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(os.tmpdir(), `uc-engine-${randomBytes(4).toString("hex")}`, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, "unblocked");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  const inherited = process.env.PATH ?? "";
  const env = {
    ...noPushEnv(),
    PATH: `${bin}${path.delimiter}${inherited}`,
    UC_ENGINE_DIR: dir,
    UC_ENGINE_AGENT: opts.agent,
    UC_ENGINE_MODEL: opts.engine.model ?? opts.model ?? "",
    UC_ENGINE_REPO: opts.repo,
    UC_ENGINE_TIMEOUT: String(opts.engine.timeoutSeconds),
    UC_ENGINE_INSTRUCTIONS: opts.engine.instructions ?? "",
    // The research agent's own PATH: without the shim, so it cannot recurse.
    UC_ENGINE_PATH: inherited,
  };
  return { env, command: shim };
}

export function readEngineCalls(armOutDir: string): EngineSummary {
  const file = path.join(engineDir(armOutDir), "calls.jsonl");
  const calls: EngineCall[] = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as EngineCall]; } catch { return []; } })
    : [];
  return { calls, costUsd: calls.reduce((s, c) => s + c.costUsd, 0), durationMs: calls.reduce((s, c) => s + c.durationMs, 0) };
}
