import fs from "node:fs";
import type { AttributedTurn, Attribution, AttributionTotals, TurnLabel } from "./types.ts";
import { costAt, formatCost, formatDuration, log, priceFor } from "./util.ts";
import { runStructured, VERIFY_CMD } from "./analyst.ts";
import { parseStreamJson } from "./claude.ts";

interface WalkTool { name: string; args: string; result: string }
export interface WalkTurn {
  turn: number;
  text: string;
  tools: WalkTool[];
  startMs: number;
  costUsd: number;
  durationMs: number;
  modelMs: number;
  toolMs: number;
  stallMs: number;
  outputTokens: number;
  outputExact: boolean;
  cacheReadTokens: number;
  inputTokens: number;
  cacheWriteTokens: number;
}

const STALL_MS = 5 * 60 * 1000;
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}

function excerpt(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function argsExcerpt(name: string, input: Record<string, unknown>): string {
  if (name === "Bash") return "`" + excerpt(String(input.command ?? ""), 220) + "`";
  if (name === "Edit") return `${String(input.file_path ?? "").split("/").slice(-3).join("/")}: "${excerpt(String(input.old_string ?? ""), 60)}" -> "${excerpt(String(input.new_string ?? ""), 60)}"`;
  if (name === "Write") return `${String(input.file_path ?? "").split("/").slice(-3).join("/")} (${String(input.content ?? "").length} chars)`;
  if (name === "Read") return String(input.file_path ?? "").split("/").slice(-3).join("/");
  const q = input.query ?? input.url ?? input.urls ?? input.pattern;
  return q ? excerpt(String(q), 160) : excerpt(JSON.stringify(input), 160);
}

function resultExcerpt(name: string, args: string, body: string): string {
  if (name === "Bash" && VERIFY_CMD.test(args)) return "…" + excerpt(body.slice(-600), 600);
  return excerpt(body, 300);
}

const tsOf = (e: { timestamp?: unknown }): number => typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;

export function buildWalk(jsonl: string, totalCostUsd: number | null): WalkTurn[] {
  const events = jsonl.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  interface Row extends WalkTurn { id: string; rawCost: number; chars: number; thinkingEst: number; usage: Record<string, number>; cache1h: number; model: string; lastBlockMs: number; lastResultMs: number; segmentStartMs: number; nestedOutput: number; cliTurn: number; wakes: boolean; endMs: number }
  const rows: Row[] = [];
  const byId = new Map<string, Row>();
  const pending = new Map<string, { tool: WalkTool; row: Row }>();
  const exactOutput = new Map<string, number>();
  let streamMsgId = "";
  const parsed = parseStreamJson(jsonl, null, true);
  const totalOutput = parsed.tokenUsage.outputTokens;
  const totalThinking = Object.values(parsed.tokenUsage.byModel ?? {}).reduce((a, m) => a + (m.thinkingTokens ?? 0), 0);
  let pendingThinking = 0;
  let firstTs = NaN;
  let segmentStartMs = NaN;
  let awaitingFirstEvent = false;
  let cliTurn = 0;
  let afterResult = false;
  let rowsInSegment = 0;
  const cliTurnMs = new Map<number, number>();

  for (const e of events) {
    const t = tsOf(e);
    if (!Number.isNaN(t) && Number.isNaN(firstTs)) firstTs = t;
    if (e.type === "harness" && e.subtype === "session_start") {
      cliTurn++; afterResult = false; rowsInSegment = 0;
      if (Number.isNaN(t)) awaitingFirstEvent = true; else { segmentStartMs = t; awaitingFirstEvent = false; }
      continue;
    }
    if (!Number.isNaN(t) && awaitingFirstEvent) { segmentStartMs = t; awaitingFirstEvent = false; }
    if (e.type === "result") {
      if (typeof e.duration_ms === "number") cliTurnMs.set(cliTurn, e.duration_ms);
      cliTurn++; afterResult = true;
      continue;
    }
    if (e.type === "system" && e.subtype === "thinking_tokens") { pendingThinking += e.estimated_tokens_delta ?? 0; continue; }

    if (typeof e.parent_tool_use_id === "string") {
      if (e.type === "stream_event" && e.event?.type === "message_delta" && typeof e.event.usage?.output_tokens === "number") {
        const parent = pending.get(String(e.parent_tool_use_id))?.row;
        if (parent) parent.nestedOutput += e.event.usage.output_tokens;
      }
      if (e.type === "assistant") {
        const parent = pending.get(String(e.parent_tool_use_id))?.row;
        if (parent) {
          const u = e.message?.usage ?? {};
          const price = priceFor(typeof e.message?.model === "string" ? e.message.model : "opus");
          const oneH = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
          const key = `nested:${e.message?.id ?? ""}`;
          if (!byId.has(key)) {
            byId.set(key, parent);
            parent.cacheReadTokens += u.cache_read_input_tokens ?? 0;
            parent.inputTokens += u.input_tokens ?? 0;
            parent.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
            parent.rawCost += costAt(price, { inputTokens: u.input_tokens ?? 0, outputTokens: 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheCreationTokens: (u.cache_creation_input_tokens ?? 0) - oneH }) + (oneH / 1_000_000) * price.cacheWrite1h;
          }
          for (const block of e.message?.content ?? []) {
            if (block.type === "text" && block.text) parent.chars += block.text.length;
            if (block.type === "tool_use") parent.chars += JSON.stringify(block.input ?? {}).length;
          }
        }
      }
      continue;
    }

    if (e.type === "stream_event") {
      const ev = e.event ?? {};
      if (ev.type === "message_start" && ev.message?.id) streamMsgId = String(ev.message.id);
      if (ev.type === "message_delta" && streamMsgId && typeof ev.usage?.output_tokens === "number") exactOutput.set(streamMsgId, ev.usage.output_tokens);
      continue;
    }

    if (e.type === "assistant") {
      const id = String(e.message?.id ?? `evt-${rows.length}`);
      let row = byId.get(id);
      if (!row) {
        const u = e.message?.usage ?? {};
        row = {
          id, turn: rows.length + 1, text: "", tools: [], startMs: 0, costUsd: 0, durationMs: 0, modelMs: 0, toolMs: 0, stallMs: 0,
          outputTokens: 0, outputExact: false, cacheReadTokens: u.cache_read_input_tokens ?? 0,
          inputTokens: u.input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          rawCost: 0, chars: 0, thinkingEst: pendingThinking, usage: u, cache1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0, nestedOutput: 0,
          model: typeof e.message?.model === "string" ? e.message.model : "opus",
          lastBlockMs: NaN, lastResultMs: NaN, segmentStartMs, cliTurn, wakes: afterResult && rowsInSegment > 0, endMs: NaN,
        };
        afterResult = false; rowsInSegment++;
        pendingThinking = 0;
        rows.push(row); byId.set(id, row);
      }
      if (!Number.isNaN(t)) row.lastBlockMs = Number.isNaN(row.lastBlockMs) ? t : Math.max(row.lastBlockMs, t);
      for (const block of e.message?.content ?? []) {
        if (block.type === "thinking") row.chars += String(block.thinking ?? "").length;
        if (block.type === "text" && block.text) { row.text += excerpt(block.text, 200) + " "; row.chars += block.text.length; }
        if (block.type === "tool_use" && block.name) {
          row.chars += JSON.stringify(block.input ?? {}).length;
          const tool: WalkTool = { name: block.name, args: argsExcerpt(block.name, block.input ?? {}), result: "" };
          row.tools.push(tool);
          if (block.id) pending.set(block.id, { tool, row });
        }
      }
    } else if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block.type !== "tool_result") continue;
        const p = pending.get(block.tool_use_id);
        if (!p) continue;
        pending.delete(block.tool_use_id);
        if (!Number.isNaN(t)) p.row.lastResultMs = Number.isNaN(p.row.lastResultMs) ? t : Math.max(p.row.lastResultMs, t);
        const body = Array.isArray(block.content) ? block.content.map((c: { text?: string }) => c.text ?? "").join(" ") : String(block.content ?? "");
        p.tool.result = (block.is_error ? "[ERROR] " : "") + resultExcerpt(p.tool.name, p.tool.args, body);
      }
    }
  }

  let prevEnd = firstTs;
  for (const r of rows) {
    if (!Number.isNaN(r.segmentStartMs) && r.segmentStartMs > prevEnd) prevEnd = r.segmentStartMs;
    const end = Number.isNaN(r.lastResultMs) ? r.lastBlockMs : Math.max(r.lastBlockMs, r.lastResultMs);
    if (!Number.isNaN(prevEnd) && !Number.isNaN(end)) {
      r.startMs = prevEnd;
      r.modelMs = Math.max(0, r.lastBlockMs - prevEnd);
      r.toolMs = Math.max(0, end - r.lastBlockMs);
      r.durationMs = r.modelMs + r.toolMs;
      r.endMs = end;
      prevEnd = end;
    }
  }
  for (const first of rows) {
    const cli = cliTurnMs.get(first.cliTurn);
    if (!first.wakes || cli === undefined || !first.startMs) continue;
    const lastEnd = Math.max(...rows.filter(r => r.cliTurn === first.cliTurn && !Number.isNaN(r.endMs)).map(r => r.endMs));
    const idle = Math.min(first.modelMs, Math.max(0, lastEnd - first.startMs - cli));
    first.modelMs -= idle;
    first.toolMs += idle;
  }
  const typical = median(rows.filter(r => r.modelMs > 0 && r.modelMs <= STALL_MS).map(r => r.modelMs));
  for (const r of rows) {
    if (r.modelMs <= STALL_MS || typical <= 0) continue;
    r.stallMs = r.modelMs - typical;
    r.modelMs = typical;
    r.durationMs = r.modelMs + r.toolMs;
  }

  let exactSum = 0, inexactChars = 0, inexactThinking = 0;
  for (const r of rows) {
    if (exactOutput.has(r.id)) { r.outputTokens = exactOutput.get(r.id)! + r.nestedOutput; r.outputExact = true; exactSum += r.outputTokens; }
    else { inexactChars += r.chars; inexactThinking += r.thinkingEst; }
  }
  const remaining = Math.max(0, totalOutput - exactSum);
  const thinkingShare = Math.min(remaining, totalThinking);
  const visibleShare = remaining - thinkingShare;
  for (const r of rows) {
    if (r.outputExact) continue;
    const think = inexactThinking > 0 ? thinkingShare * (r.thinkingEst / inexactThinking) : 0;
    const vis = inexactChars > 0 ? visibleShare * (r.chars / inexactChars) : 0;
    r.outputTokens = Math.round(think + vis);
  }

  for (const r of rows) {
    r.text = r.text.trim();
    const price = priceFor(r.model);
    r.rawCost += costAt(price, {
      inputTokens: r.usage.input_tokens ?? 0, outputTokens: r.outputTokens,
      cacheReadTokens: r.usage.cache_read_input_tokens ?? 0, cacheCreationTokens: 0,
    }) + (((r.usage.cache_creation_input_tokens ?? 0) - r.cache1h) / 1_000_000) * price.cacheWrite + (r.cache1h / 1_000_000) * price.cacheWrite1h;
  }
  const rawSum = rows.reduce((a, r) => a + r.rawCost, 0);
  const scale = totalCostUsd && rawSum > 0 ? totalCostUsd / rawSum : 1;
  for (const r of rows) r.costUsd = r.rawCost * scale;
  return rows.map(({ id: _id, rawCost: _rc, chars: _c, thinkingEst: _te, usage: _u, cache1h: _h, model: _m, lastBlockMs: _lb, lastResultMs: _lr, segmentStartMs: _ss, nestedOutput: _no, cliTurn: _ct, wakes: _w, endMs: _e, ...t }) => t);
}

function renderWalk(walk: WalkTurn[]): string {
  return walk.map(t => {
    const lines = [`Turn ${t.turn}${t.text ? ` — agent: "${t.text}"` : ""}`];
    for (const tool of t.tools) lines.push(`  ${tool.name} ${tool.args}${tool.result ? `\n    -> ${tool.result}` : ""}`);
    if (t.tools.length === 0 && !t.text) lines.push("  (thinking only)");
    return lines.join("\n");
  }).join("\n");
}

const SCHEMA = {
  type: "object",
  properties: {
    turns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          turn: { type: "integer" },
          label: { type: "string", enum: ["work", "verify", "housekeeping"] },
          repeat_of: { type: ["integer", "null"] },
          reason: { type: "string" },
        },
        required: ["turn", "label", "repeat_of", "reason"],
      },
    },
  },
  required: ["turns"],
};

export function analystPrompt(task: string, walk: WalkTurn[]): string {
  return `You are reviewing the transcript of an autonomous coding agent that was given a task. Label every turn so that task work can be measured separately from routine housekeeping. Both the agent's cost and its wall-clock time will be split by these labels, so be precise and consistent.

Labels:
- work: reading or searching code and docs, calling research tools, deciding, editing files, writing documentation, or writing the final summary. A turn that only narrates the next step is work.
- verify: running tests, linters, type checks, builds or CI to validate the change, and environment setup those runs need (starting a database or containers, preparing a test database). A re-run is verify only if the agent changed code since the previous run, or the previous run failed for a reason related to the change.
- housekeeping: activity that neither advances nor validates the task. Examples: reverting incidental changes to lockfiles or generated files; deleting build artifacts or temp files; git status, branch or log checks not needed to proceed; creating branches; committing; re-running a check that already passed with no code change in between; re-running after a failure unrelated to the change (a flaky test, infrastructure, a timeout); every turn spent confirming, once the agent has already concluded a failure is unrelated to its change, that the confirmation is right (a clean-HEAD or control run, a mutation test, re-reading the same log) — the agent already has its answer, and proving the negative at length validates nothing.
- Two distinctions matter, both about the SUBJECT of a check, not its form:
  1. A deliberate control experiment on the change itself, or on a code path the change plausibly affects — running the unmodified code, or a specific variant, to learn whether a failure the change could have caused pre-exists, or what causes it, done once and used in the agent's conclusions — is verify. The identical move aimed at a failure the agent has already identified as unrelated (a different module, an untouched code path, a flaky or known-bad test) is housekeeping from the point the agent reaches that conclusion, however many turns it then spends reconfirming it.
  2. Verifying the specific behaviour the task's acceptance criteria describes is verify, even when it is expensive or repeated for a good reason stated in the transcript (a non-deterministic check run more than once to rule out flakiness, an ablation that removes the change to show a test fails without it). Verifying something the task does not ask for, or that a sibling module merely happens to also touch, is not entitled to that latitude once its result stops changing what the agent does next.

Rules:
- Label every turn, in order, turn numbers exactly as given.
- A turn cannot be split. If it mixes purposes, label it by its dominant purpose. A turn that both commits and runs CI is housekeeping if the CI run is a repeat.
- Set repeat_of to the turn number this one redundantly repeats, otherwise null. A repeated verify run counts as housekeeping.
- The final summary turn (text only, no tool call, at the end) is work.
- reason: at most eight words, e.g. "reverts incidental lockfile change" or "commits checkpoint".

The task the agent was given:
"""
${task.slice(0, 2500)}
"""

Transcript (one entry per turn; "->" lines are tool results, truncated):
${renderWalk(walk)}
`;
}

type RawLabels = { turns: { turn: number; label: TurnLabel["label"]; repeat_of: number | null; reason: string }[] };

export async function classifyTurns(walk: WalkTurn[], task: string, model: string): Promise<{ labels: TurnLabel[]; analystCostUsd: number; modelUsed: string } | null> {
  const res = await runStructured<RawLabels>("Attribution", analystPrompt(task, walk), model, SCHEMA, 10 * 60 * 1000);
  if (!res) return null;
  const labels: TurnLabel[] = res.data.turns.map(t => ({ turn: t.turn, label: t.label, repeatOf: t.repeat_of ?? null, reason: t.reason }));
  return { labels, analystCostUsd: res.costUsd, modelUsed: res.modelUsed };
}

function totals(rows: AttributedTurn[]): AttributionTotals {
  const sum = (f: (r: AttributedTurn) => number) => rows.reduce((a, r) => a + f(r), 0);
  return {
    costUsd: sum(r => r.costUsd), inputTokens: sum(r => r.inputTokens), cacheWriteTokens: sum(r => r.cacheWriteTokens),
    durationMs: sum(r => r.durationMs), modelMs: sum(r => r.modelMs), toolMs: sum(r => r.toolMs), stallMs: sum(r => r.stallMs),
    turns: rows.length, outputTokens: sum(r => r.outputTokens), cacheReadTokens: sum(r => r.cacheReadTokens),
  };
}

export function rollup(walk: WalkTurn[], labels: TurnLabel[], analystModel: string, analystCostUsd: number): Attribution {
  const byTurn = new Map(labels.map(l => [l.turn, l]));
  const rows: AttributedTurn[] = walk.map(t => {
    const l = byTurn.get(t.turn) ?? { turn: t.turn, label: "work" as const, repeatOf: null, reason: "(unlabelled by analyst; counted as work)" };
    const summary = t.tools.length ? t.tools.map(x => `${x.name} ${x.args}`).join("; ").slice(0, 160) : (t.text.slice(0, 160) || "(thinking only)");
    return { ...l, startMs: t.startMs, costUsd: t.costUsd, durationMs: t.durationMs, modelMs: t.modelMs, toolMs: t.toolMs, stallMs: t.stallMs, outputTokens: t.outputTokens, cacheReadTokens: t.cacheReadTokens, inputTokens: t.inputTokens, cacheWriteTokens: t.cacheWriteTokens, summary };
  });
  const housekeeping = rows.filter(r => r.label === "housekeeping");
  const core = rows.filter(r => r.label !== "housekeeping");
  return {
    analystModel, analystCostUsd, outputExact: walk.length > 0 && walk.every(t => t.outputExact),
    raw: totals(rows), core: totals(core), housekeeping: totals(housekeeping), turns: rows,
  };
}

export async function attribute(jsonlPath: string, task: string, totalCostUsd: number | null, model: string, tag: string): Promise<Attribution | null> {
  const walk = buildWalk(fs.readFileSync(jsonlPath, "utf8"), totalCostUsd);
  if (walk.length === 0) { log(`[${tag}] Attribution: no messages in transcript`); return null; }
  log(`[${tag}] Attribution: labelling ${walk.length} messages with ${model}…`);
  const res = await classifyTurns(walk, task, model);
  if (!res) return null;
  const a = rollup(walk, res.labels, res.modelUsed, res.analystCostUsd);
  log(`[${tag}] Attribution: core ${formatCost(a.core.costUsd)} / ${formatDuration(a.core.durationMs)} (${a.core.turns} msgs); housekeeping ${formatCost(a.housekeeping.costUsd)} / ${formatDuration(a.housekeeping.durationMs)} (${a.housekeeping.turns} msgs)${a.raw.stallMs > 0 ? `; stalled ${formatDuration(a.raw.stallMs)} (machine sleep or API outage, excluded)` : ""}; analyst ${formatCost(res.analystCostUsd)} via ${res.modelUsed}${a.outputExact ? "" : "; per-message output estimated"}`);
  return a;
}
