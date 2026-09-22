import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { Condition, RunResult, TokenUsage, ToolCall } from "./types.ts";
import { log } from "./util.ts";
import { git, tryGit } from "./git.ts";

const BINARY = process.env.CLAUDE_BINARY ?? "claude";

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  thinkingTokens?: number;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
}

interface ParsedStream {
  tokenUsage: TokenUsage;
  toolCalls: ToolCall[];
  assistantTurns: number;
  finalResponse: string;
  sessionId?: string;
  totalCostUsd: number | null;
  cliDurationMs: number | null;
  sessionCumulative: SessionCumulative | null;
  apiError: string | null;
}

export interface SessionCumulative { modelUsage: Record<string, ModelUsage>; costUsd: number | null }

function parseToolName(name: string): { isMcp: boolean; mcpServer?: string } {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return { isMcp: true, mcpServer: parts[1] };
  }
  if (name.includes("::")) {
    return { isMcp: true, mcpServer: name.split("::")[0] };
  }
  return { isMcp: false };
}

export function parseStreamJson(jsonl: string, prior: SessionCumulative | null = null, quiet = false): ParsedStream {
  const events = jsonl
    .split("\n")
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e) => e !== null);

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const toolCalls: ToolCall[] = [];
  const pending = new Map<string, ToolCall>();
  const messageIds = new Set<string>();
  let finalResponse = "";
  let sessionId: string | undefined;
  let totalCostUsd: number | null = null;
  let cliDurationMs: number | null = null;

  let segLast: Record<string, ModelUsage> | null = null;
  let segFallback: TokenUsage | null = null;
  let segCost: number | null = null;
  const segMessageTokens = new Map<string, number>();
  let cumulative: SessionCumulative | null = prior;
  let apiError: string | null = null;
  let messagesSinceResult = false;
  const addFallback = (acc: TokenUsage | null, u: Record<string, number>): TokenUsage => ({
    inputTokens: (acc?.inputTokens ?? 0) + (u.input_tokens ?? 0), outputTokens: (acc?.outputTokens ?? 0) + (u.output_tokens ?? 0),
    cacheReadTokens: (acc?.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0), cacheCreationTokens: (acc?.cacheCreationTokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
  });
  const nonOutput = (mu: Record<string, ModelUsage>) => Object.values(mu).reduce((a, m) => a + (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0), 0);
  const USAGE_FIELDS = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] as const;
  const flushSegment = () => {
    if (segLast) {
      const before = cumulative;
      const own = [...segMessageTokens.values()].reduce((a, n) => a + n, 0);
      const reported = nonOutput(segLast);
      const base = before ? nonOutput(before.modelUsage) : 0;
      const covers = !!before && Object.entries(before.modelUsage).every(([model, pm]) => USAGE_FIELDS.every(f => (segLast![model]?.[f] ?? 0) >= (pm[f] ?? 0)));
      const carried = !!before && base > 0 && covers && Math.abs(reported - base - own) < Math.abs(reported - own);
      if (carried && !quiet) log(`parse: modelUsage (${Math.round(reported / 1000)}k input-side tokens) is cumulative over the resumed session; subtracting the previous process's ${Math.round(base / 1000)}k${before!.costUsd !== null ? ` and $${before!.costUsd.toFixed(2)}` : ""}`);
      const delta = (model: string, mu: ModelUsage, f: keyof ModelUsage): number => Math.max(0, (mu[f] ?? 0) - (carried ? before!.modelUsage[model]?.[f] ?? 0 : 0));
      const byModel: Record<string, TokenUsage> = usage.byModel ?? {};
      for (const [model, mu] of Object.entries(segLast)) {
        const m: TokenUsage = {
          inputTokens: delta(model, mu, "inputTokens"),
          outputTokens: delta(model, mu, "outputTokens"),
          cacheReadTokens: delta(model, mu, "cacheReadInputTokens"),
          cacheCreationTokens: delta(model, mu, "cacheCreationInputTokens"),
          ...(typeof mu.costUSD === "number" ? { costUsd: delta(model, mu, "costUSD") } : {}),
          ...(typeof mu.thinkingTokens === "number" ? { thinkingTokens: delta(model, mu, "thinkingTokens") } : {}),
        };
        if (carried && !m.inputTokens && !m.outputTokens && !m.cacheReadTokens && !m.cacheCreationTokens) continue;
        const prev = byModel[model];
        byModel[model] = prev ? {
          inputTokens: prev.inputTokens + m.inputTokens, outputTokens: prev.outputTokens + m.outputTokens,
          cacheReadTokens: prev.cacheReadTokens + m.cacheReadTokens, cacheCreationTokens: prev.cacheCreationTokens + m.cacheCreationTokens,
          ...((prev.costUsd ?? m.costUsd) !== undefined ? { costUsd: (prev.costUsd ?? 0) + (m.costUsd ?? 0) } : {}),
          ...((prev.thinkingTokens ?? m.thinkingTokens) !== undefined ? { thinkingTokens: (prev.thinkingTokens ?? 0) + (m.thinkingTokens ?? 0) } : {}),
        } : m;
        usage.inputTokens += m.inputTokens;
        usage.outputTokens += m.outputTokens;
        usage.cacheReadTokens += m.cacheReadTokens;
        usage.cacheCreationTokens += m.cacheCreationTokens;
      }
      usage.byModel = byModel;
      if (segCost !== null) totalCostUsd = (totalCostUsd ?? 0) + Math.max(0, segCost - (carried ? before!.costUsd ?? 0 : 0));
      cumulative = { modelUsage: segLast, costUsd: segCost ?? before?.costUsd ?? null };
    } else {
      if (segFallback) {
        usage.inputTokens += segFallback.inputTokens;
        usage.outputTokens += segFallback.outputTokens;
        usage.cacheReadTokens += segFallback.cacheReadTokens;
        usage.cacheCreationTokens += segFallback.cacheCreationTokens;
      }
      if (segCost !== null) totalCostUsd = (totalCostUsd ?? 0) + segCost;
    }
    segLast = null; segFallback = null; segCost = null; segMessageTokens.clear();
  };

  for (const e of events) {
    const eventMs = typeof e?.timestamp === "string" ? Date.parse(e.timestamp) : NaN;

    if (e?.type === "system" && e?.subtype === "init") {
      sessionId = e.session_id;
    }

    if (e?.type === "user" && Array.isArray(e.message?.content)) {
      for (const block of e.message.content as ContentBlock[]) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        pending.delete(block.tool_use_id);
        if (!Number.isNaN(eventMs) && call.timestamp > 0) {
          call.durationMs = Math.max(0, eventMs - call.timestamp);
        }
      }
    }

    if (e?.type === "assistant") {
      const nested = typeof e.parent_tool_use_id === "string";
      const synthetic = e.message?.model === "<synthetic>";
      if (!nested) { messageIds.add(String(e.message?.id ?? `evt-${messageIds.size}`)); messagesSinceResult = true; }
      const mu = e.message?.usage;
      if (mu && e.message?.id) segMessageTokens.set(String(e.message.id), (mu.input_tokens ?? 0) + (mu.cache_read_input_tokens ?? 0) + (mu.cache_creation_input_tokens ?? 0));
      const content: ContentBlock[] = e.message?.content ?? [];
      for (const block of content) {
        if (!nested && !synthetic && block.type === "text" && typeof block.text === "string") {
          finalResponse = block.text;
        }
        if (block.type === "tool_use" && block.name) {
          const { isMcp, mcpServer } = parseToolName(block.name);
          const call: ToolCall = {
            name: block.name,
            args: block.input ?? {},
            timestamp: Number.isNaN(eventMs) ? 0 : eventMs,
            isMcp,
            mcpServer,
            model: typeof e.message?.model === "string" ? e.message.model : undefined,
            nested: typeof e.parent_tool_use_id === "string" ? true : undefined,
          };
          toolCalls.push(call);
          if (block.id) pending.set(block.id, call);
        }
      }
      if (e.session_id) sessionId = e.session_id;
    }

    if (e?.type === "harness" && e?.subtype === "session_start") {
      flushSegment();
      continue;
    }
    if (e?.type === "result") {
      const failed = e.is_error === true && typeof e.api_error_status === "number";
      if (failed) apiError = `API error ${e.api_error_status}: ${String(e.result ?? "").slice(0, 120)}`;
      else if (typeof e.result === "string" && e.result.trim()) finalResponse = e.result;
      messagesSinceResult = false;
      if (e.modelUsage && typeof e.modelUsage === "object") segLast = e.modelUsage as Record<string, ModelUsage>;
      else if (e.usage) segFallback = addFallback(segFallback, e.usage);
      if (typeof e.total_cost_usd === "number") segCost = e.total_cost_usd;
      if (typeof e.duration_ms === "number") cliDurationMs = (cliDurationMs ?? 0) + e.duration_ms;
      if (e.session_id) sessionId = e.session_id;
    }
  }
  flushSegment();
  if (messagesSinceResult) cliDurationMs = null;

  return { tokenUsage: usage, toolCalls, assistantTurns: messageIds.size, finalResponse, sessionId, totalCostUsd, cliDurationMs, sessionCumulative: cumulative, apiError };
}

function isUnblockedTool(name: string): boolean {
  return name.toLowerCase().includes("unblocked");
}

function isUnblockedCliCall(name: string, args: Record<string, unknown>): boolean {
  if (name !== "Bash") return false;
  const cmd = (args.command as string) ?? "";
  return /^unblocked\s+context[_-]/.test(cmd);
}

const WORKTREE_BASE = path.join(os.tmpdir(), "claude-harness-wt");

export function worktreePath(repoPath: string, name: string): string {
  const repoName = path.basename(repoPath);
  return path.join(WORKTREE_BASE, repoName, name);
}

export function createWorktree(repoPath: string, name: string, branch: string): { path: string; baseSha: string } {
  const wtPath = worktreePath(repoPath, name);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  git(repoPath, ["worktree", "add", "--detach", wtPath, branch]);
  if (fs.existsSync(path.join(wtPath, ".gitmodules"))) {
    if (tryGit(wtPath, ["submodule", "update", "--init", "--recursive"], "initialising submodules in worktree") !== null) log(`Initialised submodules in ${name}`);
  }
  const baseSha = git(wtPath, ["rev-parse", "HEAD"]).trim();
  return { path: wtPath, baseSha };
}

export function removeWorktree(repoPath: string, name: string, refsBefore: Map<string, string> | null, agentCommits: Set<string>): void {
  const wtPath = worktreePath(repoPath, name);
  if (tryGit(repoPath, ["worktree", "remove", "--force", wtPath], `removing worktree ${name}`) === null) {
    tryGit(repoPath, ["worktree", "prune"], "pruning worktrees");
  }
  if (!refsBefore) { log(`Skipping branch cleanup for ${name}: no ref snapshot from run start`); return; }
  if (agentCommits.size === 0) return;

  const checkedOut = new Set((tryGit(repoPath, ["worktree", "list", "--porcelain"], "listing worktrees") ?? "").split("\n").filter(l => l.startsWith("branch ")).map(l => l.slice(7).trim()));
  const now = tryGit(repoPath, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"], "listing branches after run") ?? "";
  for (const line of now.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const sha = line.slice(0, sp), ref = line.slice(sp + 1), short = ref.replace(/^refs\/heads\//, "");
    if (!agentCommits.has(sha)) continue;
    const before = refsBefore.get(ref);
    if (before === undefined) {
      if (tryGit(repoPath, ["branch", "-D", short], `deleting agent-created branch ${short}`) !== null) log(`Deleted agent-created branch ${short} (was ${sha.slice(0, 7)})`);
    } else if (before !== sha) {
      if (checkedOut.has(ref)) { log(`Agent moved pre-existing branch ${short} to ${sha.slice(0, 7)}, but it is checked out in another worktree; left as is (pre-run sha ${before.slice(0, 7)})`); continue; }
      if (tryGit(repoPath, ["update-ref", ref, before, sha], `resetting ${short} to its pre-run sha`) !== null) {
        log(`Agent moved pre-existing branch ${short} to ${sha.slice(0, 7)}; reset to ${before.slice(0, 7)}. The agent's commit is still reachable by sha for a while.`);
      }
    }
  }
}

const UNBLOCKED_MCP_TOOLS = [
  "mcp__unblocked__context_research",
  "mcp__unblocked__context_get_urls",
  "mcp__unblocked__context_get_rules",
  "mcp__unblocked__submit_feedback",
];

export async function runClaude(opts: {
  prompt: string;
  worktreePath: string;
  model: string;
  condition: Condition;
  timeoutMs: number;
  outDir: string;
  blockUnblocked: boolean;
  resumeSessionId?: string;
  priorTranscriptPath?: string;
  jsonlName?: string;
}): Promise<RunResult> {
  const jsonlPath = path.join(opts.outDir, opts.jsonlName ?? `${opts.condition}.jsonl`);

  const args = [
    "-p", opts.prompt,
    ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    "--model", opts.model,
  ];

  if (opts.blockUnblocked) {
    for (const tool of UNBLOCKED_MCP_TOOLS) {
      args.push("--disallowed-tools", tool);
    }
    args.push("--disallowed-tools", "Bash(unblocked *)");
  }

  const started = Date.now();

  const result = await new Promise<{ exitCode: number | null; timedOut: boolean; killedReason?: string }>((resolve, reject) => {
    const p = spawn(BINARY, args, {
      cwd: opts.worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
    });

    p.stdin.end();

    const out = fs.createWriteStream(jsonlPath);
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

    p.stdout.on("data", (chunk: Buffer) => {
      out.write(chunk);
      partial += chunk.toString();
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);

          if (e?.type === "assistant") {
            turnCount++;
            const content: ContentBlock[] = e.message?.content ?? [];
            let text = "";
            for (const block of content) {
              if (block.type === "text" && block.text) {
                text += block.text;
              }
              if (block.type === "tool_use" && block.name) {
                toolCount++;
                const toolName = block.name;
                const input = block.input ?? {};
                let label = "";

                if (toolName === "Bash") {
                  const cmd = (input.command as string) ?? "";
                  label = `Bash: ${cmd.slice(0, 100)}`;
                } else if (toolName === "Edit") {
                  editCount++;
                  const fp = (input.file_path as string) ?? "";
                  label = `✏️  Edit #${editCount}: ...${fp.slice(-60)}`;
                } else if (toolName === "Read") {
                  const fp = (input.file_path as string) ?? "";
                  label = `Read: ...${fp.slice(-60)}`;
                } else if (toolName === "Write") {
                  const fp = (input.file_path as string) ?? "";
                  label = `Write: ...${fp.slice(-60)}`;
                } else if (toolName === "Skill") {
                  const skill = (input.skill as string) ?? (input.name as string) ?? "";
                  label = `Skill: ${skill}`;
                } else {
                  const { isMcp, mcpServer } = parseToolName(toolName);
                  if (isMcp) {
                    const query = (input.query as string) ?? (input.url as string) ?? "";
                    label = `MCP:${mcpServer}/${toolName.split(/__|::/).pop()} ${query ? `"${query.slice(0, 80)}"` : ""}`;
                  } else {
                    label = toolName;
                  }
                }
                if (label) log(`[${tag}]   #${toolCount} ${label}`);

                const isUbMcp = isUnblockedTool(toolName);
                const isUbCli = isUnblockedCliCall(toolName, input);

                if (opts.condition === "baseline" && !killed && (isUbMcp || isUbCli)) {
                  log(`[${tag}] ⛔ CONTAMINATION: baseline called Unblocked — killing run`);
                  kill("contamination: the baseline called Unblocked");
                }

                if (opts.condition === "unblocked" && !unblockedCallSeen && (isUbMcp || isUbCli)) {
                  unblockedCallSeen = true;
                  log(`[${tag}] ✅ Unblocked call detected`);
                }
              }
            }
            if (text) {
              log(`[${tag}] 🗣️  Turn ${turnCount}: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
            }
          } else if (e?.type === "result") {
            const dur = e.duration_ms ? `${Math.round(e.duration_ms / 1000)}s` : "";
            const cost = e.total_cost_usd ? `$${e.total_cost_usd.toFixed(4)}` : "";
            log(`[${tag}] 📊 Result: ${e.num_turns ?? "?"} turns, ${dur}, ${cost}`);
          }
        } catch {}
      }
    });

    p.stderr.on("data", (d: Buffer) => process.stderr.write(`[claude:${opts.condition}] ${d}`));

    p.on("close", (code) => {
      clearInterval(ticker);
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
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    ...(killedReason ? { killedReason } : {}),
    jsonlPath,
    worktreePath: opts.worktreePath,
    totalCostUsd: parsed.totalCostUsd,
    ...(parsed.totalCostUsd === null ? { costEstimated: true } : {}),
  };
}
