// The canonical transcript format is Claude Code's stream-json. The Claude
// adapter writes it as the CLI emits it; the Cursor and Codex adapters
// translate their own event streams into it (see src/agents/), so every
// analysis pass reads one format whatever agent ran.
import type { TokenUsage, ToolCall } from "./types.ts";
import { log } from "./util.ts";

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
  model?: string;
}

export interface SessionCumulative { modelUsage: Record<string, ModelUsage>; costUsd: number | null }

export function parseToolName(name: string): { isMcp: boolean; mcpServer?: string } {
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
  let model: string | undefined;
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
      if (typeof e.model === "string" && e.model) model ??= e.model;
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

  return { tokenUsage: usage, toolCalls, assistantTurns: messageIds.size, finalResponse, sessionId, totalCostUsd, cliDurationMs, sessionCumulative: cumulative, apiError, model };
}
