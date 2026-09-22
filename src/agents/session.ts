import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { RunResult } from "../types.ts";
import { log } from "../util.ts";
import { parseStreamJson, parseToolName } from "../transcript.ts";
import type { AgentRunOpts } from "./types.ts";

// Turns one line of the agent CLI's stdout into zero or more canonical
// (Claude Code stream-json) events. `receivedMs` is when the line arrived, for
// CLIs whose events carry no timestamp. Stateful: one per session.
export interface Translator {
  translate(line: string, receivedMs: number): object[];
}

// A Claude transcript is already canonical: pass each event through as is.
export const identity = (): Translator => ({
  translate(line) {
    try { return [JSON.parse(line)]; } catch { return []; }
  },
});

interface ContentBlock { type: string; text?: string; name?: string; input?: Record<string, unknown> }

function isUnblockedCall(name: string, input: Record<string, unknown>): boolean {
  if (name.toLowerCase().includes("unblocked")) return true;
  return name === "Bash" && /^unblocked\s+context[_-]/.test((input.command as string) ?? "");
}

function toolLabel(toolName: string, input: Record<string, unknown>, editCount: number): string {
  if (toolName === "Bash") return `Bash: ${((input.command as string) ?? "").slice(0, 100)}`;
  if (toolName === "Edit") return `✏️  Edit #${editCount}: ...${String(input.file_path ?? "").slice(-60)}`;
  if (toolName === "Read") return `Read: ...${String(input.file_path ?? "").slice(-60)}`;
  if (toolName === "Write") return `Write: ...${String(input.file_path ?? "").slice(-60)}`;
  if (toolName === "Skill") return `Skill: ${(input.skill as string) ?? (input.name as string) ?? ""}`;
  const { isMcp, mcpServer } = parseToolName(toolName);
  if (!isMcp) return toolName;
  const query = (input.query as string) ?? (input.url as string) ?? "";
  return `MCP:${mcpServer}/${toolName.split(/__|::/).pop()} ${query ? `"${query.slice(0, 80)}"` : ""}`;
}

// Spawn an agent CLI in the arm's worktree, stream its output through the
// translator into the canonical transcript, and enforce the run's guards: the
// awake-time timeout, the baseline contamination kill, and the Unblocked arm's
// 120s deadline to make its first Unblocked call.
export async function runSession(opts: AgentRunOpts & {
  binary: string;
  args: string[];
  translator: Translator;
  // Keep the CLI's own output next to the canonical transcript when they differ.
  keepRaw: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<RunResult> {
  const jsonlPath = path.join(opts.outDir, opts.jsonlName ?? `${opts.condition}.jsonl`);
  const rawPath = jsonlPath.replace(/\.jsonl$/, ".raw.jsonl");
  const started = Date.now();

  const result = await new Promise<{ exitCode: number | null; timedOut: boolean; killedReason?: string }>((resolve, reject) => {
    const p = spawn(opts.binary, opts.args, {
      cwd: opts.worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ?? process.env,
    });

    const out = fs.createWriteStream(jsonlPath);
    const raw = opts.keepRaw ? fs.createWriteStream(rawPath) : null;
    out.write(JSON.stringify({ type: "harness", subtype: "session_start", timestamp: new Date().toISOString(), condition: opts.condition, resume: !!opts.resumeSessionId }) + "\n");
    let partial = "";
    let toolCount = 0;
    let editCount = 0;
    let turnCount = 0;
    const tag = opts.condition;
    let killed = false;
    let killedReason: string | undefined;
    const kill = (reason: string) => {
      killed = true;
      killedReason = reason;
      p.kill("SIGTERM");
      setTimeout(() => p.kill("SIGKILL"), 5_000);
    };

    let unblockedCallSeen = false;

    let awakeMs = 0;
    let lastTick = Date.now();
    const unblockedDeadlineMs = opts.condition === "unblocked" && !opts.resumeSessionId ? 120_000 : Infinity;
    let unblockedDeadlineFired = false;
    let timedOut = false;
    const ticker = setInterval(() => {
      const now = Date.now();
      const gap = now - lastTick;
      lastTick = now;
      if (gap > 30_000) log(`[${tag}] machine was asleep or stalled for ${Math.round(gap / 1000)}s; not counted against deadlines`);
      else awakeMs += gap;
      if (!unblockedDeadlineFired && awakeMs >= unblockedDeadlineMs) {
        unblockedDeadlineFired = true;
        if (!unblockedCallSeen && !killed) {
          log(`[${tag}] ⛔ Unblocked not called within 120s — killing run`);
          kill("the Unblocked arm made no Unblocked call within 120s");
        }
      }
      if (!timedOut && awakeMs >= opts.timeoutMs) {
        timedOut = true;
        if (!killed) kill(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
      }
    }, 5_000);

    const onEvent = (e: { type?: string; message?: { content?: ContentBlock[] }; num_turns?: number; duration_ms?: number; total_cost_usd?: number }) => {
      if (e?.type === "assistant") {
        turnCount++;
        let text = "";
        for (const block of e.message?.content ?? []) {
          if (block.type === "text" && block.text) text += block.text;
          if (block.type !== "tool_use" || !block.name) continue;
          toolCount++;
          const input = block.input ?? {};
          if (block.name === "Edit") editCount++;
          log(`[${tag}]   #${toolCount} ${toolLabel(block.name, input, editCount)}`);

          const ub = isUnblockedCall(block.name, input);
          if (opts.condition === "baseline" && !killed && ub) {
            log(`[${tag}] ⛔ CONTAMINATION: baseline called Unblocked — killing run`);
            kill("contamination: the baseline called Unblocked");
          }
          if (opts.condition === "unblocked" && !unblockedCallSeen && ub) {
            unblockedCallSeen = true;
            log(`[${tag}] ✅ Unblocked call detected`);
          }
        }
        if (text) log(`[${tag}] 🗣️  Turn ${turnCount}: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
      } else if (e?.type === "result") {
        const dur = e.duration_ms ? `${Math.round(e.duration_ms / 1000)}s` : "";
        const cost = e.total_cost_usd ? `$${e.total_cost_usd.toFixed(4)}` : "";
        log(`[${tag}] 📊 Result: ${e.num_turns ?? turnCount} turns, ${dur}, ${cost}`);
      }
    };

    p.stdout.on("data", (chunk: Buffer) => {
      const receivedMs = Date.now();
      raw?.write(chunk);
      partial += chunk.toString();
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let events: object[] = [];
        try { events = opts.translator.translate(line, receivedMs); } catch (err) { log(`[${tag}] translate failed: ${(err as Error).message}`); }
        for (const e of events) {
          out.write(JSON.stringify(e) + "\n");
          onEvent(e);
        }
      }
    });

    p.stderr.on("data", (d: Buffer) => process.stderr.write(`[${path.basename(opts.binary)}:${opts.condition}] ${d}`));

    p.on("close", (code) => {
      clearInterval(ticker);
      raw?.end();
      out.end(() => resolve({ exitCode: code, timedOut, killedReason }));
    });

    p.on("error", reject);
  });

  const jsonl = fs.readFileSync(jsonlPath, "utf8");
  const prior = opts.priorTranscriptPath ? parseStreamJson(fs.readFileSync(opts.priorTranscriptPath, "utf8"), null, true).sessionCumulative : null;
  const parsed = parseStreamJson(jsonl, prior);
  const killedReason = result.killedReason ?? (parsed.apiError ? `the CLI stopped on an ${parsed.apiError}` : undefined);
  if (parsed.apiError && !result.killedReason) log(`[${opts.condition}] ⛔ ${killedReason}; the pass did not run to completion`);

  const wallMs = Date.now() - started;
  return {
    durationMs: parsed.cliDurationMs ?? wallMs,
    wallMs,
    tokenUsage: parsed.tokenUsage,
    toolCalls: parsed.toolCalls,
    assistantTurns: parsed.assistantTurns,
    finalResponse: parsed.finalResponse,
    sessionId: parsed.sessionId,
    ...(parsed.model ?? opts.model ? { model: parsed.model ?? opts.model } : {}),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    ...(killedReason ? { killedReason } : {}),
    jsonlPath,
    worktreePath: opts.worktreePath,
    totalCostUsd: parsed.totalCostUsd,
    ...(parsed.totalCostUsd === null ? { costEstimated: true } : {}),
  };
}
