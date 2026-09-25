import fs from "node:fs";
import path from "node:path";
import type { ArmResult, ComparisonResult, Met, ToolCall } from "./types.ts";
import { formatCost, formatDiffSummary, formatDuration, formatTokens, modelCost, padLeft, padRight, priceFor, totalTokens, uncachedTokens } from "./util.ts";
import { AGENTS, type AgentName } from "./agents/index.ts";
import { reconcile, type Totals } from "./context-effect.ts";
import { BATCH_CSS, COUNT_UP, FONTS, REPORT_CSS } from "./report-style.ts";
import type { TokenUsage } from "./types.ts";
import { unblockedCommand } from "./unblocked-cli.ts";

const W = 78;

function r(content: string): string {
  return "║" + padRight(content, W + 2) + "║";
}

function blank(): string {
  return "║" + " ".repeat(W + 2) + "║";
}

function divider(): string {
  return "╠" + "═".repeat(W + 2) + "╣";
}

const BASH_WRITE_RE = new RegExp([
  String.raw`(?:^|[\s;&|(])cat\s*>{1,2}\s*[^\s&|;>]+\s*<<`,
  String.raw`(?:python3?|ruby|node|perl)\s+-\s*<<[\s\S]*?(?:write_text\(|\.write\(|open\([^)]*["'][wa]|writeFileSync|File\.write|IO\.write)`,
  String.raw`\bsed\s+(?:-[a-zA-Z]*\s+)*-i\b`,
  String.raw`\bperl\s+-p?i\b`,
  String.raw`\btee\s+(?:-a\s+)?(?!/dev/)[\w./-]+`,
  String.raw`\bgit\s+apply\b`,
  String.raw`(?:^|[\s;&|])patch\s+(?:-p\d\s+)?[<\w]`,
  String.raw`(?:^|[^\w<>=&$-])>{1,2}\s*(?!/dev/|&)['"]?[\w./~-]+`,
].join("|"), "m");

function bashWritesFiles(cmd: string): boolean {
  return BASH_WRITE_RE.test(cmd);
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if ((line + " " + word).trim().length > width) { out.push(line.trim()); line = word; } else line = (line + " " + word).trim();
  }
  if (line) out.push(line);
  return out;
}

function toolCategory(tc: ToolCall): string {
  if (tc.isMcp) {
    return tc.mcpServer?.toLowerCase().includes("unblocked") ? "Unblocked" : `MCP:${tc.mcpServer}`;
  }
  if (tc.name === "Bash") {
    const cmd = (tc.args.command as string) ?? "";
    if (unblockedCommand(cmd)) return "Unblocked";
    return bashWritesFiles(cmd) ? "Bash (writes files)" : "Bash";
  }
  return tc.name;
}

function unionMs(calls: ToolCall[]): number {
  const spans = calls
    .filter(tc => !tc.nested && tc.timestamp > 0 && (tc.durationMs ?? 0) > 0)
    .map(tc => [tc.timestamp, tc.timestamp + (tc.durationMs as number)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  let total = 0, curStart = -1, curEnd = -1;
  for (const [s, e] of spans) {
    if (s > curEnd) { if (curEnd > curStart) total += curEnd - curStart; curStart = s; curEnd = e; }
    else if (e > curEnd) curEnd = e;
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

export function toolTimeMs(arm: ArmResult): number {
  return unionMs(arm.run.toolCalls);
}

function hasTiming(arm: ArmResult): boolean {
  return arm.run.toolCalls.some(tc => (tc.durationMs ?? 0) > 0);
}

function coreToolTimeMs(arm: ArmResult): number { return arm.attribution ? arm.attribution.core.toolMs : toolTimeMs(arm); }
function coreModelTimeMs(arm: ArmResult): number { return arm.attribution ? arm.attribution.core.modelMs : modelTimeMs(arm); }

function sharedRequirementsTable(result: ComparisonResult): string {
  const spec = result.reviewSpec;
  if (!spec) return "";
  const last = (arm: ArmResult) => arm.review?.passes[arm.review.passes.length - 1];
  const cell = (arm: ArmResult, i: number) => {
    const r = last(arm)?.requirements.find(x => x.index === i);
    if (!r) return "<td>–</td>";
    return `<td><span class="met ${r.status === "met" ? "met-met" : r.status === "unmet" ? "met-unmet" : "met-partial"}">${r.status}</span><div class="evidence">${escapeHtml(r.note)}</div></td>`;
  };
  const paidFor = (arm: ArmResult, index: number) => (arm.review?.passes ?? []).filter(p => p.fix && !(p.waiversInForce ?? []).includes(index) && p.requirements.some(r => r.index === index && (r.status === "unmet" || r.status === "partial"))).length;
  const adj = spec.adjudications.map(a => {
    const cost = a.waived ? [["Baseline", result.baseline], [L.arm, result.unblocked]].map(([n, arm]) => [n, paidFor(arm as ArmResult, a.index)] as const).filter(([, k]) => k > 0).map(([n, k]) => `${n} had already spent ${k} fix pass(es) on it before the waiver`).join("; ") : "";
    return `<li>Requirement ${a.index + 1}, disputed by ${a.disputedBy === "unblocked" ? `the ${L.short} arm` : "the baseline arm"} in round ${a.round}: <b>${a.waived ? "waived for both arms" : a.excludes ? `stands, but does not cover ${escapeHtml(a.excludes)} (both arms)` : "dispute rejected"}</b>. ${escapeHtml(a.reason)}${cost ? ` <span class="met met-partial">${escapeHtml(cost)}</span>` : ""}</li>`;
  }).join("");
  return `<div class="tool-table-wrap"><table class="tool-table">
      <thead><tr><th>Requirement (same list for both arms)</th><th>Baseline</th><th>${L.arm}</th></tr></thead>
      <tbody>${spec.requirements.map((req, i) => `<tr><td>${i + 1}. ${escapeHtml(req)}</td>${cell(result.baseline, i)}${cell(result.unblocked, i)}</tr>`).join("")}</tbody>
    </table></div>${adj ? `<ul class="section-note" style="margin: 8px 0 0 18px;">${adj}</ul>` : ""}`;
}

function stallNote(b: ArmResult, u: ArmResult): string {
  const bs = b.attribution?.raw.stallMs ?? 0, us = u.attribution?.raw.stallMs ?? 0;
  if (bs <= 0 && us <= 0) return "";
  return `<div class="section-note">Stalled time excluded from all figures: baseline ${formatDuration(bs)}, with ${L.short} ${formatDuration(us)}. A model wait longer than five minutes is the machine asleep or the API down, not generation.</div>`;
}

function housekeepingKinds(arm: ArmResult): string {
  const a = arm.attribution;
  if (!a) return "";
  const kinds: Record<string, number> = {};
  for (const t of a.turns) {
    if (t.label !== "housekeeping") continue;
    const s = t.summary.toLowerCase();
    const k = /commit/.test(s) ? "commit" : /checkout -b|switch -c|branch/.test(s) ? "branch" : /git status|git diff --stat|git log|rev-parse/.test(s) ? "status checks"
      : /package-lock|lockfile|checkout --|checkout -- /.test(s) ? "lockfile revert" : /rm -rf|rm -f|rmdir|dist|coverage/.test(s) ? "artifact cleanup"
      : /rspec|bin\/ci|npm|go test|test:js/.test(s) ? "redundant rerun" : /thinking/.test(s) ? "thinking" : "other";
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  return Object.entries(kinds).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ×${n}`).join(", ");
}

const MET_ICON: Record<Met, string> = { met: "✓", partial: "◐", unmet: "✗" };

function shellOnlyEdits(arm: ArmResult): boolean {
  const editors = arm.run.toolCalls.filter(tc => ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tc.name)).length;
  return arm.diffStats.filesChanged > 0 && editors === 0;
}

function toolTimeBreakdown(toolCalls: ToolCall[]): Record<string, number> {
  const byCat: Record<string, ToolCall[]> = {};
  for (const tc of toolCalls) (byCat[toolCategory(tc)] ??= []).push(tc);
  return Object.fromEntries(Object.entries(byCat).map(([c, calls]) => [c, unionMs(calls)]));
}

function modelTimeMs(arm: ArmResult): number {
  return Math.max(0, arm.run.durationMs - toolTimeMs(arm));
}

function slowestTools(toolCalls: ToolCall[], n: number): ToolCall[] {
  return [...toolCalls]
    .filter(tc => (tc.durationMs ?? 0) > 0 && !tc.nested && toolCategory(tc) !== "Unblocked")
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, n);
}

function toolLabel(tc: ToolCall): string {
  if (tc.name === "Bash") return `Bash: ${((tc.args.command as string) ?? "").replace(/\s+/g, " ").slice(0, 90)}`;
  if (tc.isMcp) return `${toolCategory(tc)}: ${((tc.args.query as string) ?? (tc.args.url as string) ?? "").slice(0, 80)}`;
  const fp = (tc.args.file_path as string) ?? "";
  return fp ? `${tc.name}: ...${fp.slice(-60)}` : tc.name;
}

// category -> model label -> count. Calls without model info land under "".
function toolBreakdown(toolCalls: ToolCall[]): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const tc of toolCalls) {
    const category = toolCategory(tc);
    const model = tc.model ? modelLabel(tc.model) : "";
    const byModel = counts[category] ?? {};
    byModel[model] = (byModel[model] ?? 0) + 1;
    counts[category] = byModel;
  }
  return counts;
}

function toolTotal(byModel: Record<string, number> | undefined): number {
  return Object.values(byModel ?? {}).reduce((a, n) => a + n, 0);
}

// "claude-haiku-4-5-20251001" → "haiku-4-5"
function modelLabel(id: string): string {
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function modelEntries(usage: TokenUsage): [string, TokenUsage][] {
  return Object.entries(usage.byModel ?? {});
}

// path.basename can't split Windows paths on macOS/Linux, and transcripts may
// come from either platform.
function repoName(repoPath: string): string {
  return repoPath.split(/[\\/]+/).filter(Boolean).pop() ?? repoPath;
}

function pctChange(baseline: number, treatment: number): string {
  if (baseline === 0) return "N/A";
  const pct = ((treatment - baseline) / baseline) * 100;
  return `${pct >= 0 ? "+" : ""}${Math.round(pct)}%`;
}

function armSummary(label: string, arm: ArmResult): string[] {
  const u = arm.run.tokenUsage;
  const timedOut = arm.run.timedOut;
  const tokensAvail = totalTokens(u) > 0;
  return [
    `  ${padRight(label.toUpperCase() + (arm.run.killedReason ? ` [KILLED: ${arm.run.killedReason}]` : timedOut ? " [TIMED OUT]" : ""), 28)}Time        Cost     Output   Turns`,
    `  ${"─".repeat(W - 2)}`,
    `  ${padRight("Task", 28)}${padLeft(formatDuration(arm.run.durationMs), 10)}  ${padLeft(tokensAvail ? formatCost(arm.estimatedCost) : "N/A", 10)}  ${padLeft(tokensAvail ? formatTokens(u.outputTokens) : "N/A", 8)}  ${padLeft(String(arm.run.assistantTurns), 3)}`,
    ...(hasTiming(arm) ? [
      `  ${padRight("  model / tools", 28)}${padLeft(formatDuration(modelTimeMs(arm)), 10)} / ${padLeft(formatDuration(toolTimeMs(arm)), 10)}`,
    ] : []),
    ...(tokensAvail ? [
      `  ${padRight("Tokens in/out", 28)}${padLeft(formatTokens(u.inputTokens), 10)} / ${padLeft(formatTokens(u.outputTokens), 10)}`,
      `  ${padRight("  (cache r/w)", 28)}${padLeft(formatTokens(u.cacheReadTokens), 10)} / ${padLeft(formatTokens(u.cacheCreationTokens), 10)}`,
      ...modelEntries(u).map(([m, mu]) =>
        `  ${padRight(`  ${modelLabel(m)}`, 28)}${padLeft(formatTokens(uncachedTokens(mu)), 10)}  ${padLeft(formatTokens(mu.cacheReadTokens), 10)} cached  ${padLeft(formatCost(modelCost(m, mu)), 8)}`),
    ] : []),
    `  ${padRight("Tool calls", 28)}${padLeft(String(arm.run.toolCalls.length), 10)}  Unblocked: ${arm.unblockedCalls.length}${shellOnlyEdits(arm) ? "  (all edits via shell)" : ""}`,
    `  ${padRight("Diff", 28)}${formatDiffSummary(arm.diffStats)}`,
    ...(arm.attribution ? [
      `  ${padRight("Core work", 28)}${padLeft(formatDuration(arm.attribution.core.durationMs), 10)}  ${padLeft(formatCost(arm.attribution.core.costUsd), 10)}  ${padLeft(formatTokens(arm.attribution.core.outputTokens), 8)}  ${padLeft(String(arm.attribution.core.turns), 3)}`,
      `  ${padRight("Housekeeping", 28)}${padLeft(formatDuration(arm.attribution.housekeeping.durationMs), 10)}  ${padLeft(formatCost(arm.attribution.housekeeping.costUsd), 10)}  ${padLeft(formatTokens(arm.attribution.housekeeping.outputTokens), 8)}  ${padLeft(String(arm.attribution.housekeeping.turns), 3)}`,
    ] : []),
  ];
}

export function printReport(result: ComparisonResult): void {
  L = labelsFor(result);
  const b = result.baseline;
  const u = result.unblocked;

  const lines: string[] = [
    "",
    "╔" + "═".repeat(W + 2) + "╗",
    r("  UNBLOCKED COMPARE — COMPARISON"),
    divider(),
    r(`  Repo:     ${repoName(result.repo)}`),
    r(`  Branch:   ${result.branch}`),
    r(`  Agent:    ${agentLabel(result)}${result.contextEngine === "simulated" ? " · simulated context engine" : ""}`),
    ...tldrLines(result).map(l => r(l)),
    r(`  Model:    ${result.model}`),
    r(`  Task:     ${result.task.slice(0, 60)}${result.task.length > 60 ? "..." : ""}`),

    divider(),
    blank(),
    ...armSummary(L.baseline, b).map(s => r(s)),

    blank(),
    ...armSummary(L.arm, u).map(s => r(s)),

    divider(),
    blank(),
    ...(b.attribution && u.attribution ? [
      r("  1 · CORE TASK WORK  (information gathering, coding, testing — housekeeping removed)"),
      r(`  ${"─".repeat(W - 2)}`),
      r(`  ${padRight("Cost", 28)}${padLeft(formatCost(b.attribution.core.costUsd), 10)}  →  ${padLeft(formatCost(u.attribution.core.costUsd), 10)}  (${pctChange(b.attribution.core.costUsd, u.attribution.core.costUsd)})`),
      r(`  ${padRight("Model time (headline)", 28)}${padLeft(formatDuration(coreModelTimeMs(b)), 10)}  →  ${padLeft(formatDuration(coreModelTimeMs(u)), 10)}  (${pctChange(coreModelTimeMs(b), coreModelTimeMs(u))})`),
      r(`  ${padRight("  tool wait (variant)", 28)}${padLeft(formatDuration(coreToolTimeMs(b)), 10)}  →  ${padLeft(formatDuration(coreToolTimeMs(u)), 10)}  (${pctChange(coreToolTimeMs(b), coreToolTimeMs(u))})`),
      r(`  ${padRight("  core total", 28)}${padLeft(formatDuration(b.attribution.core.durationMs), 10)}  →  ${padLeft(formatDuration(u.attribution.core.durationMs), 10)}  (${pctChange(b.attribution.core.durationMs, u.attribution.core.durationMs)})`),
      r(`  ${padRight("Output tokens", 28)}${padLeft(formatTokens(b.attribution.core.outputTokens), 10)}  →  ${padLeft(formatTokens(u.attribution.core.outputTokens), 10)}  (${pctChange(b.attribution.core.outputTokens, u.attribution.core.outputTokens)})`),
      r(`  ${padRight("Cache-read tokens", 28)}${padLeft(formatTokens(b.attribution.core.cacheReadTokens), 10)}  →  ${padLeft(formatTokens(u.attribution.core.cacheReadTokens), 10)}  (${pctChange(b.attribution.core.cacheReadTokens, u.attribution.core.cacheReadTokens)})`),
      r(`  ${padRight("Turns", 28)}${padLeft(String(b.attribution.core.turns), 10)}  →  ${padLeft(String(u.attribution.core.turns), 10)}  (${pctChange(b.attribution.core.turns, u.attribution.core.turns)})`),
      blank(),
      r("  2 · HOUSEKEEPING  (model habit: tidying, committing, redundant reruns — not context-driven)"),
      r(`  ${"─".repeat(W - 2)}`),
      r(`  ${padRight("Baseline", 28)}${padLeft(String(b.attribution.housekeeping.turns), 4)} turns  ${padLeft(formatCost(b.attribution.housekeeping.costUsd), 9)}  ${padLeft(formatDuration(b.attribution.housekeeping.durationMs), 8)}  ${housekeepingKinds(b).slice(0, 40)}`),
      r(`  ${padRight(L.short, 28)}${padLeft(String(u.attribution.housekeeping.turns), 4)} turns  ${padLeft(formatCost(u.attribution.housekeeping.costUsd), 9)}  ${padLeft(formatDuration(u.attribution.housekeeping.durationMs), 8)}  ${housekeepingKinds(u).slice(0, 40)}`),
      ...((b.attribution.raw.stallMs > 0 || u.attribution.raw.stallMs > 0) ? [r(`  ${padRight("Stalled (excluded)", 28)}${padLeft(formatDuration(b.attribution.raw.stallMs), 10)}  →  ${padLeft(formatDuration(u.attribution.raw.stallMs), 10)}   machine sleep or API outage`)] : []),
      r(`  ${padRight("Raw totals (incl. hk)", 28)}${padLeft(formatCost(b.estimatedCost), 10)}  →  ${padLeft(formatCost(u.estimatedCost), 10)}   ${padLeft(formatDuration(b.run.durationMs), 8)} → ${formatDuration(u.run.durationMs)}`),
    ] : [
      r("  COMPARISON (raw; run with attribution for the core/housekeeping split)"),
      r(`  ${"─".repeat(W - 2)}`),
      r(`  ${padRight("Duration", 28)}${padLeft(formatDuration(b.run.durationMs), 10)}  →  ${padLeft(formatDuration(u.run.durationMs), 10)}  (${pctChange(b.run.durationMs, u.run.durationMs)})`),
      r(`  ${padRight("Est. Cost", 28)}${padLeft(formatCost(b.estimatedCost), 10)}  →  ${padLeft(formatCost(u.estimatedCost), 10)}  (${pctChange(b.estimatedCost, u.estimatedCost)})`),
      r(`  ${padRight("Output tokens", 28)}${padLeft(formatTokens(b.run.tokenUsage.outputTokens), 10)}  →  ${padLeft(formatTokens(u.run.tokenUsage.outputTokens), 10)}  (${pctChange(b.run.tokenUsage.outputTokens, u.run.tokenUsage.outputTokens)})`),
    ]),
    ...(result.quality ? [
      blank(),
      r("  3 · QUALITY  (blinded judge)"),
      r(`  ${"─".repeat(W - 2)}`),
      r(`  ${padRight("Verdict", 28)}${result.quality.verdict.better}`),
      ...(result.quality.discoveries ? (["baseline", "unblocked"] as const).filter(a => result.quality!.discoveries![a].kind !== "none").map(a => r(`  ${padRight("  decisive discovery", 28)}${a}: ${result.quality!.discoveries![a].kind} — ${result.quality!.discoveries![a].fact.slice(0, 40)}`)) : []),
      ...result.quality.criteria.map(c => r(`  ${padRight("  " + c.criterion, 28)}${padLeft(String(c.baseline.score), 10)}  →  ${padLeft(String(c.unblocked.score), 10)}  / 5`)),
      r(`  ${padRight("Requirements met", 28)}${padLeft(result.quality.requirements.filter(x => x.baseline.status === "met").length + "/" + result.quality.requirements.length, 10)}  →  ${padLeft(result.quality.requirements.filter(x => x.unblocked.status === "met").length + "/" + result.quality.requirements.length, 10)}`),
    ] : []),
    ...(result.impact?.economics ? [
      blank(),
      r("  EXPLANATION OF NUMBERS"),
      r(`  ${"─".repeat(W - 2)}`),
      ...["cost", "time", "tokens"].flatMap(k => wrap(`${k}: ${result.impact!.economics![k as "cost" | "time" | "tokens"]}`, W - 4).map(l => r(`  ${l}`))),
    ] : []),
    ...(result.impact ? [
      blank(),
      r("  4 · CONTEXT IMPACT  (un-blinded)"),
      r(`  ${"─".repeat(W - 2)}`),
      r(`  ${padRight("Outcome / context / driver", 28)}${result.impact.impact.outcome} / ${result.impact.impact.contextEffect} / ${result.impact.impact.outcomeDriver}`),
      r(`  ${padRight("Research calls", 28)}${result.impact.research.map(x => x.value).join(", ")}`),
      ...(result.impact.loss && result.impact.loss.unblockedFailure !== "n/a" ? [r(`  ${padRight("Why baseline won", 28)}${result.impact.loss.unblockedFailure}`)] : []),
    ] : []),
  ];

  if (u.unblockedCalls.length > 0) {
    lines.push(blank());
    lines.push(r(`  UNBLOCKED CONTEXT (${u.unblockedCalls.length} calls)`));
    lines.push(r(`  ${"─".repeat(W - 2)}`));
    const byTool: Record<string, string[]> = {};
    for (const call of u.unblockedCalls) {
      const list = byTool[call.tool] ?? [];
      if (call.query) list.push(call.query);
      byTool[call.tool] = list;
    }
    for (const [tool, queries] of Object.entries(byTool)) {
      const preview = queries.slice(0, 2).map(q => `"${q.slice(0, 28)}"`).join(", ");
      lines.push(r(`  ${padRight(tool, 24)}${preview}`));
    }
  }

  lines.push(blank());
  lines.push(r(`  Longest arm: ${formatDuration(result.totalDurationMs)}    Arms cost: ${formatCost(result.totalEstimatedCost)}${result.analysisCostUsd ? `    Analysis: ${formatCost(result.analysisCostUsd)}` : ""}`));
  const engine = result.unblocked.contextEngine;
  if (engine) lines.push(r(`  Simulated context engine: ${engine.calls.length} call(s), ${formatDuration(engine.durationMs)}, ${formatCost(engine.costUsd)} (not in arms cost)`));
  if (engine?.discountedMs) lines.push(r(`    research time counted as ≤${formatDuration(engine.capMs ?? 0)} per call: ${formatDuration(engine.discountedMs)} removed from ${L.short} timings`));
  lines.push("╚" + "═".repeat(W + 2) + "╝");
  lines.push("");

  console.log(lines.join("\n"));
}

export function writeJsonResult(result: ComparisonResult, outDir: string): void {
  const cut = (d: string) => d.length > 100_000 ? d.slice(0, 100_000) + `\n… (diff truncated for result.json; ${d.length} chars in full)` : d;
  const clean = {
    ...result,
    baseline: { ...result.baseline, diff: cut(result.baseline.diff) },
    unblocked: { ...result.unblocked, diff: cut(result.unblocked.diff) },
  };
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(clean, null, 2));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDiff(diff: string): string {
  if (!diff || diff.startsWith("(")) {
    return `<span style="color: var(--text-muted)">${escapeHtml(diff)}</span>`;
  }
  return diff.split("\n").map(line => {
    const escaped = escapeHtml(line);
    if (line.startsWith("+++") || line.startsWith("---")) return `<span class="diff-meta">${escaped}</span>`;
    if (line.startsWith("@@")) return `<span class="diff-hunk">${escaped}</span>`;
    if (line.startsWith("diff ")) return `<span class="diff-file">${escaped}</span>`;
    if (line.startsWith("+")) return `<span class="diff-add">${escaped}</span>`;
    if (line.startsWith("-")) return `<span class="diff-del">${escaped}</span>`;
    return escaped;
  }).join("\n");
}

function barWidth(value: number, max: number): number {
  return max === 0 ? 0 : Math.round((value / max) * 100);
}

export function writeHtmlReport(result: ComparisonResult, outDir: string): string {
  L = labelsFor(result);
  const b = result.baseline;
  const u = result.unblocked;
  const toolsB = toolBreakdown(b.run.toolCalls);
  const toolsU = toolBreakdown(u.run.toolCalls);
  const timeB = toolTimeBreakdown(b.run.toolCalls);
  const timeU = toolTimeBreakdown(u.run.toolCalls);
  const allTools = [...new Set([...Object.keys(toolsB), ...Object.keys(toolsU)])].sort();
  const hasToolTiming = hasTiming(b) || hasTiming(u);
  const hasAttr = !!(b.attribution && u.attribution);
  const hasCoreTiming = hasAttr && (b.attribution!.raw.durationMs > 0 || u.attribution!.raw.durationMs > 0);
  const timeCell = (ms: number | undefined) => ms ? formatDuration(ms) : `<span style="color: var(--text-muted)">–</span>`;

  const armModels = (tools: Record<string, Record<string, number>>) =>
    new Set(Object.values(tools).flatMap(byModel => Object.keys(byModel)));
  const bMultiModel = armModels(toolsB).size > 1;
  const uMultiModel = armModels(toolsU).size > 1;

  const toolCell = (byModel: Record<string, number> | undefined, multiModel: boolean) => {
    const total = toolTotal(byModel);
    if (total === 0 || !multiModel) return String(total);
    const split = Object.entries(byModel ?? {})
      .map(([m, n]) => `${escapeHtml(m || "unknown")} ${n}`)
      .join(" &middot; ");
    return `${total} <span style="color: var(--text-muted); font-size: 12px;">(${split})</span>`;
  };

  const economicsBlock = (r: ComparisonResult) => {
    const e = r.economics!;
    const ex = r.impact?.economics;
    const usd = (n: number) => (n >= 0 ? "+" : "−") + "$" + Math.abs(n).toFixed(2);
    const tok = (n: number) => (n >= 0 ? "+" : "−") + formatTokens(Math.abs(n));
    const min = (ms: number) => (ms >= 0 ? "+" : "−") + formatDuration(Math.abs(ms));
    const allTok = (x: { inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number }) => x.inputTokens + x.cacheWriteTokens + x.cacheReadTokens + x.outputTokens;
    const para = (title: string, text: string | undefined, facts: string) => `
      <div class="finding" style="margin-bottom: 8px;"><b>${title}</b>${text ? `<div style="margin-top: 4px;">${escapeHtml(text)}</div>` : ""}<div class="evidence" style="margin-top: 6px;">${facts}</div></div>`;
    const toolKinds = Object.entries(e.time.toolWaitDelta).filter(([, v]) => Math.abs(v) >= 1000).sort((a, b2) => Math.abs(b2[1]) - Math.abs(a[1])).map(([k, v]) => `${escapeHtml(k)} ${min(v)}`).join(", ");
    return `
    <div class="section-title" style="font-size: 15px; margin-top: 24px;">Why the measured numbers differ <span class="section-sub">${L.short} relative to baseline${e.basis === "raw" ? "; whole-run figures, attribution missing for at least one arm" : ""}</span></div>
    <div class="findings">
      ${para("Cost " + usd(e.cost.deltaUsd), ex?.cost, `output ${usd(e.cost.terms.output)} · cache-read ${usd(e.cost.terms.cacheRead)} · cache-write ${usd(e.cost.terms.cacheWrite)} · input ${usd(e.cost.terms.input)}${Math.abs(e.cost.unexplainedUsd) >= 0.01 ? ` · residual ${usd(e.cost.unexplainedUsd)}` : ""}`)}
      ${para("Time " + min(e.time.deltaMs), ex?.time, `model time ${min(e.time.modelDeltaMs)} · tool wait ${min(e.time.toolDeltaMs)}${toolKinds ? ` (${toolKinds})` : ""}`)}
      ${para("Tokens " + tok(allTok(e.unblocked) - allTok(e.baseline)), ex?.tokens, `input ${tok(e.unblocked.inputTokens - e.baseline.inputTokens)} · cache-write ${tok(e.unblocked.cacheWriteTokens - e.baseline.cacheWriteTokens)} · cache-read ${tok(e.cacheRead.deltaTokens)} · output ${tok(e.output.deltaTokens)}<br>output = thinking ${tok(e.output.thinkingDelta)} + visible ${tok(e.output.visibleDelta)} · cache-read: research context carried ≈ ${tok(e.cacheRead.researchCarriedTokens)}, average context per message ${tok(e.cacheRead.contextPerMessageDelta)}, messages ${e.cacheRead.messagesDelta >= 0 ? "+" : ""}${e.cacheRead.messagesDelta} · ${L.short} research: ${e.unblocked.research.calls} calls, ≈${formatTokens(e.unblocked.research.payloadTokens)} tokens returned`)}
    </div>`;
  };

  const coreTokens = (arm: ArmResult) => { const c = arm.attribution!.core; return c.inputTokens + c.cacheWriteTokens + c.cacheReadTokens + c.outputTokens; };
  const heroCard = (label: string, bVal: number, uVal: number, fmt: (n: number) => string) => {
    const pct = pctChange(bVal, uVal);
    const cls = pct === "N/A" || /^[+-]?0%$/.test(pct) ? " neutral" : uVal < bVal ? " positive" : " negative";
    return `
    <div class="hero-card${cls}">
      <div class="hero-label">${label}</div>
      <div class="hero-value${cls}">${pct}</div>
      <div class="hero-detail">${fmt(bVal)} &rarr; ${fmt(uVal)}</div>
    </div>`;
  };

  // Summary: the quality verdict, then each number as the context's influence
  // and as measured, with a bar showing how the measured difference splits
  // (the parts add up to it exactly).
  const ce = result.contextEffect;
  const signed = (n: number, fmt: (n: number) => string) => `${n < 0 ? "&minus;" : "+"}${fmt(Math.abs(n))}`;
  // Model-written text: real arrows and minus signs.
  const typeset = (t: string) => escapeHtml(t).replace(/\s*-&gt;\s*/g, " &rarr; ").replace(/(^|[\s(\/])-(?=\$?\d)/g, "$1&minus;");
  const usd2 = (n: number) => `$${n.toFixed(2)}`;
  const pctHtml = (s: string) => s.replace(/^-/, "&minus;");
  // Plain comparison: one bar per arm, then at most three short lines saying
  // what made the difference, green when it saved and red when it cost more.
  const plain = (n: number, fmt: (n: number) => string, unit: string) => `${fmt(Math.abs(n))}${unit}`;
  // A waterfall: start without the context, take off or add what the context
  // did, then what the agent did on its own (its mistakes and all other work
  // the context did not influence), and end with it. Green takes away, red adds; every bar has its label in its row.
  const compareBlock = (label: string, key: keyof Totals, fmt: (n: number) => string) => {
    const e = ce!;
    const bv = e.baseline[key], uv = e.unblocked[key];
    const r = reconcile(e, key);
    const ctxName = L.short === "Unblocked" ? "Unblocked's context" : "The context";
    const small = (v: number) => Math.abs(v) < Math.max(bv, uv) * 0.01;
    const steps: [string, string, number, boolean][] = ([
      [`${ctxName} saved`, `${ctxName} added`, r.influence, true],
      ["Agent's own choices saved", "Agent's own choices added", r.ownMistakes + r.other, false],
    ] as [string, string, number, boolean][]).filter(([, , v]) => !small(v));
    let run = bv, peak = bv;
    for (const [, , v] of steps) { run += v; peak = Math.max(peak, run); }
    const max = Math.max(peak, uv) || 1;
    const pos = (from: number, to: number) => `left: ${((Math.min(from, to) / max) * 100).toFixed(2)}%; width: ${((Math.abs(to - from) / max) * 100).toFixed(2)}%`;
    const raw = pctChange(bv, uv);
    const rawCls = raw === "N/A" || /^[+-]?0%$/.test(raw) ? "" : uv < bv ? "better" : "worse";
    const row = (name: string, cls: string, from: number, to: number, value: string, strong = false) =>
      `<div class="wf-row${strong ? " strong" : ""}"><span class="wf-name">${name}</span><div class="wf-track"><span class="wf-bar ${cls}" style="${pos(from, to)}"></span></div><span class="wf-val ${cls}">${value}</span></div>`;
    run = bv;
    const stepRows = steps.map(([saved, added, v, isCtx]) => {
      const from = run; run += v;
      return row(`${v < 0 ? saved : added}${isCtx ? ` (${pctChange(bv, bv + v).replace(/^[-+]/, "")})` : ""}`, v < 0 ? "down" : "up", from, run, `${v < 0 ? "&minus;" : "+"}${fmt(Math.abs(v))}`, isCtx);
    }).join("");
    return `
      <div class="cmp">
        <h3 class="cmp-label">${label}</h3>
        <div class="wf">
          ${row("Baseline", "base", 0, bv, fmt(bv))}
          ${stepRows}
          ${row("End result", "ctx", 0, uv, `${fmt(uv)}${rawCls ? ` <em class="${rawCls}">${pctHtml(raw)} overall</em>` : ""}`)}
        </div>
      </div>`;
  };
  const causeLabel = { context: "context", agent: "agent, not context", environment: "environment" } as const;
  // The arithmetic behind the Summary, from the episode sums below it.
  const workings = () => {
    const e = ce!;
    const keys: [keyof Totals, (n: number) => string][] = [["costUsd", usd2], ["durationMs", formatDuration], ["tokens", formatTokens]];
    const pick = (arm: "baseline" | "unblocked", ctx: boolean) => (k: keyof Totals) => e.episodes.filter(x => x.arm === arm && (x.cause === "context") === ctx).reduce((t, x) => t + x[k], 0);
    const row = (label: string, f: (k: keyof Totals) => number, cls = "", sign = false) =>
      `<tr${cls ? ` class="${cls}"` : ""}><td>${label}</td>${keys.map(([k, fmt]) => `<td>${sign ? signed(f(k), fmt) : fmt(f(k))}</td>`).join("")}</tr>`;
    const pctRow = (label: string, from: (k: keyof Totals) => number, to: (k: keyof Totals) => number) =>
      `<tr class="total-row"><td>${label}</td>${keys.map(([k]) => `<td>${pctHtml(pctChange(from(k), to(k)))}</td>`).join("")}</tr>`;
    const r = (k: keyof Totals) => reconcile(e, k);
    return `
      <table class="tool-table workings">
        <thead><tr><th>Context's influence</th><th>Cost</th><th>Time</th><th>Tokens</th></tr></thead>
        <tbody>
          ${row("Baseline, core work", k => e.baseline[k])}
          ${row(`+ ${escapeHtml(L.short)} arm's context episodes`, pick("unblocked", true), "", true)}
          ${row("&minus; Baseline's episodes for lack of the context", k => -pick("baseline", true)(k), "", true)}
          ${row("= Baseline with the context's influence", k => e.adjustedUnblocked[k], "total-row")}
          ${pctRow("Context's influence", k => e.adjustedBaseline[k], k => e.adjustedUnblocked[k])}
        </tbody>
      </table>
      <table class="tool-table workings">
        <thead><tr><th>Measured difference</th><th>Cost</th><th>Time</th><th>Tokens</th></tr></thead>
        <tbody>
          ${row(`${escapeHtml(L.short)} arm, core work`, k => e.unblocked[k])}
          ${row("&minus; Baseline, core work", k => -e.baseline[k], "", true)}
          ${row("= Measured difference", k => r(k).measured, "total-row", true)}
          ${row("of which: context's influence", k => r(k).influence, "", true)}
          ${row(`of which: agents' own mistakes (${escapeHtml(L.short)} arm's agent and environment episodes, minus the Baseline's)`, k => r(k).ownMistakes, "", true)}
          ${row("of which: other work (turns no episode covers)", k => r(k).other, "", true)}
        </tbody>
      </table>`;
  };
  const qualityRow = () => {
    const q = result.quality;
    if (!q) return "";
    const better = q.verdict.better;
    const score = (c: "baseline" | "unblocked") => {
      const reqs = q.requirements.map(r => r[c].status);
      const met = reqs.filter(s => s === "met").length, partial = reqs.filter(s => s === "partial").length;
      return `${met} of ${reqs.length} met${partial ? `, ${partial} partial` : ""}`;
    };
    return `
      <tr class="quality-row">
        <th scope="row">Quality</th>
        <td colspan="3"><span class="fig${better === "unblocked" ? " better" : better === "baseline" ? " worse" : ""}">${better === "tie" ? "Tie" : better === "unblocked" ? `${escapeHtml(L.short)} better` : "Baseline better"}</span>
          <span class="range">Requirements: Baseline ${score("baseline")}; ${escapeHtml(L.short)} ${score("unblocked")}.${q.verdict.tieBreaker?.applied ? " The blinded judge called a tie; a context-led discovery broke it." : ""}</span></td>
      </tr>`;
  };
  // The opening: the task, the verdict in a sentence, and the scoreboard.
  const [taskHead, ...taskTail] = result.task.trim().split("\n");
  const taskTitle = taskHead.length <= 110 ? taskHead : "";
  const taskRest = (taskTitle ? taskTail.join("\n") : result.task).trim();
  const boardCell = (label: string, key: keyof Totals, fmt: (n: number) => string) => {
    const e = ce!;
    const infl = pctChange(e.adjustedBaseline[key], e.adjustedUnblocked[key]);
    const cls = infl === "N/A" || /^[+-]?0%$/.test(infl) ? "" : e.adjustedUnblocked[key] < e.adjustedBaseline[key] ? " better" : " worse";
    const n = parseInt(infl, 10);
    const saved = e.adjustedUnblocked[key] - e.adjustedBaseline[key];
    return `<div class="cell"><div class="cell-label">${label}</div><div class="cell-fig${cls}"${Number.isFinite(n) ? ` data-count="${n}"` : ""}>${pctHtml(infl)}</div><div class="cell-sub">${saved < 0 ? `Context saved ${fmt(-saved)} of ${fmt(e.baseline[key])}` : saved > 0 ? `Context added ${fmt(saved)} to ${fmt(e.baseline[key])}` : "Context made no difference"}</div><div class="cell-sub">Overall: ${fmt(e.baseline[key])} &rarr; ${fmt(e.unblocked[key])} (${pctHtml(pctChange(e.baseline[key], e.unblocked[key]))})</div></div>`;
  };
  const qualityCell = () => {
    const q = result.quality;
    if (!q) return `<div class="cell"><div class="cell-label">Quality</div><div class="cell-fig word">Not judged</div></div>`;
    const better = q.verdict.better;
    const score = (c: "baseline" | "unblocked") => {
      const reqs = q.requirements.map(r => r[c].status);
      const met = reqs.filter(s => s === "met").length, partial = reqs.filter(s => s === "partial").length;
      return `${met} of ${reqs.length} met${partial ? `, ${partial} partial` : ""}`;
    };
    return `<div class="cell"><div class="cell-label">Quality with ${escapeHtml(L.short)}</div><div class="cell-fig word${better === "unblocked" ? " better" : better === "baseline" ? " worse" : ""}">${better === "tie" ? "Tie" : better === "unblocked" ? "Better" : "Worse"}</div><div class="cell-sub">${escapeHtml(L.short)} ${score("unblocked")}</div><div class="cell-sub">Baseline ${score("baseline")}${q.verdict.tieBreaker?.applied ? "; blinded tie, broken by a context-led discovery" : ""}</div></div>`;
  };
  const facts = `<dl class="facts">
      <div><dt>Repository</dt><dd>${escapeHtml(repoName(result.repo))}</dd></div>
      <div><dt>Branch</dt><dd>${escapeHtml(result.branch)}</dd></div>
      <div><dt>Agent</dt><dd>${escapeHtml(agentLabel(result))}</dd></div>
      <div><dt>Model</dt><dd>${escapeHtml(result.model)}</dd></div>
    </dl>`;
  const heroHtml = !ce ? "" : `
  <header class="hero">
    <p class="hero-meta"><span>Unblocked Compare</span><span>${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</span></p>
    <p class="hero-vs">${escapeHtml(L.vs)}</p>
    ${taskTitle ? `<h1 class="hero-task">${escapeHtml(taskTitle)}</h1>` : `<h1 class="hero-task">${escapeHtml(L.vs)}</h1>`}
    ${taskRest ? `<p class="hero-task-rest">${escapeHtml(taskRest)}</p>` : ""}
    ${ce.tldr ? `<p class="hero-lede">${typeset(ce.tldr.headline)}</p>` : ""}
    <div class="board">
      ${qualityCell()}
      ${boardCell("Cost", "costUsd", usd2)}
      ${boardCell("Time", "durationMs", formatDuration)}
      ${boardCell("Tokens", "tokens", formatTokens)}
    </div>
    ${facts}
  </header>`;
  const tldrSection = !ce ? "" : `
  <section class="section summary">
    <h2 class="section-title">What drove it</h2>
    ${ce.tldr?.bullets.length ? `<ul class="points">${ce.tldr.bullets.map(b => `<li>${typeset(b)}</li>`).join("")}</ul>` : ""}
    <h2 class="section-title">What changed the numbers</h2>
    <div class="cmps">
      ${compareBlock("Cost", "costUsd", usd2)}
      ${compareBlock("Time", "durationMs", formatDuration)}
      ${compareBlock("Tokens", "tokens", formatTokens)}
    </div>
    ${ce.episodes.length ? `<details class="ledger"><summary>How these numbers are worked out (${ce.episodes.length} episodes)</summary>
      ${workings()}
      <table class="tool-table">
        <thead><tr><th>Arm</th><th>Turns</th><th>Cause</th><th>What</th><th>Time</th><th>Cost</th><th>Tokens</th></tr></thead>
        <tbody>${ce.episodes.map(e => `<tr${e.cause === "context" ? ` class="highlight-row"` : ""}><td>${e.arm === "baseline" ? "Baseline" : escapeHtml(L.short)}</td><td class="nowrap">T${e.fromTurn}&ndash;T${e.toTurn}</td><td>${causeLabel[e.cause]}</td><td>${escapeHtml(e.what)}</td><td class="nowrap">${formatDuration(e.durationMs)}</td><td class="nowrap">${usd2(e.costUsd)}</td><td class="nowrap">${formatTokens(e.tokens)}</td></tr>`).join("")}</tbody>
      </table>
      <p class="section-note">Core work, housekeeping removed; the same figures as section 1. Episodes and causes come from the un-blinded impact pass; their time, cost and tokens are summed from the per-message figures. "Context's influence" is the Baseline plus the differences the context influenced, for better or worse: turns it shaped in the ${escapeHtml(L.short)} arm, minus the Baseline's work for lack of it. Choices each agent made on its own, and environment noise, drop out of both arms.</p>
    </details>` : ""}
  </section>`;

  const housekeepingLedger = (label: string, arm: ArmResult) => {
    const rows = arm.attribution!.turns.filter(t => t.label === "housekeeping");
    if (!rows.length) return `<div class="arm-tokens" style="color: var(--text-muted);">${escapeHtml(label)}: no housekeeping turns</div>`;
    return `
      <div class="arm-section">
        <div class="arm-header"><span class="arm-name">${escapeHtml(label)}</span></div>
        <table class="tool-table">
          <thead><tr><th>Turn</th><th>Cost</th><th>Time</th><th>What it did</th><th>Why excluded</th></tr></thead>
          <tbody>${rows.map(t => `
          <tr>
            <td>${t.turn}</td><td>${formatCost(t.costUsd)}</td><td>${formatDuration(t.durationMs)}</td>
            <td style="font-family: var(--mono); font-size: 12px;">${escapeHtml(t.summary)}</td>
            <td style="font-size: 12px; color: var(--text-muted);">${escapeHtml(t.reason)}${t.repeatOf ? ` (repeats turn ${t.repeatOf})` : ""}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>`;
  };

  const toolCompareRows = allTools.map(tool => {
    const bCount = toolTotal(toolsB[tool]);
    const uCount = toolTotal(toolsU[tool]);
    const isUnblocked = tool === "Unblocked";
    return `
      <tr class="${isUnblocked ? "highlight-row" : ""}">
        <td>${escapeHtml(tool)}</td>
        <td>${toolCell(toolsB[tool], bMultiModel)}</td>
        <td>${toolCell(toolsU[tool], uMultiModel)}</td>
        <td>${uCount - bCount >= 0 ? "+" : ""}${uCount - bCount}</td>
        ${hasToolTiming ? `<td>${timeCell(timeB[tool])}</td><td>${timeCell(timeU[tool])}</td>` : ""}
      </tr>`;
  }).join("");

  const armCard = (label: string, arm: ArmResult, accent: boolean) => {
    const t = arm.run.tokenUsage;
    const has = totalTokens(t) > 0;
    const a = arm.attribution;
    const head = a
      ? { dur: a.core.durationMs, cost: a.core.costUsd, tokens: coreTokens(arm), turns: a.core.turns, tag: "Core" }
      : { dur: arm.run.durationMs, cost: arm.estimatedCost, tokens: totalTokens(t), turns: arm.run.assistantTurns, tag: "" };
    const cap = (x: string) => head.tag ? `${head.tag} ${x.toLowerCase()}` : x;
    return `
    <div class="arm-section${accent ? " context-arm" : ""}">
      <div class="arm-header">
        <span class="arm-name">${escapeHtml(label)}${arm.run.killedReason ? ` <span style="color: var(--red); font-size: 12px;">(KILLED: ${escapeHtml(arm.run.killedReason)})</span>` : arm.run.timedOut ? ` <span style="color: var(--yellow); font-size: 12px;">(TIMED OUT)</span>` : ""}</span>
        ${a ? `<span style="font-size: 13px; color: var(--text-muted);">Whole run, housekeeping included: ${formatCost(arm.estimatedCost)}, ${formatDuration(arm.run.durationMs)}, ${formatTokens(totalTokens(t))} tokens</span>` : ""}
      </div>
      <div class="arm-meta">
        <div class="arm-stat"><div class="arm-stat-val">${has ? formatCost(head.cost) : "N/A"}${arm.run.costEstimated ? ` <span style="font-size: 11px; color: var(--yellow);">(est.)</span>` : ""}</div><div class="arm-stat-label">${cap("Cost")}</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${formatDuration(head.dur)}</div><div class="arm-stat-label">${cap("Time")}</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${has ? formatTokens(head.tokens) : "N/A"}</div><div class="arm-stat-label">${cap("Tokens")}</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${head.turns}</div><div class="arm-stat-label">${cap(a ? "Messages" : "Turns")}</div></div>
      </div>
      ${has ? `<div class="arm-tokens">
        ${a ? `Core tokens: input <span>${formatTokens(a.core.inputTokens)}</span> + cache write <span>${formatTokens(a.core.cacheWriteTokens)}</span> + cache read <span>${formatTokens(a.core.cacheReadTokens)}</span> + output <span>${formatTokens(a.core.outputTokens)}</span>`
          : `Tokens: input <span>${formatTokens(t.inputTokens)}</span> + cache write <span>${formatTokens(t.cacheCreationTokens)}</span> + cache read <span>${formatTokens(t.cacheReadTokens)}</span> + output <span>${formatTokens(t.outputTokens)}</span>`}
      </div>` : `<div class="arm-tokens" style="color: var(--text-muted);">Token data unavailable</div>`}
      <div class="arm-tokens">
        ${a ? `Core time: model <span>${formatDuration(a.core.modelMs)}</span> + tool wait <span>${formatDuration(a.core.toolMs)}</span> &nbsp; Housekeeping: <span>${a.housekeeping.turns} msgs, ${formatCost(a.housekeeping.costUsd)}, ${formatDuration(a.housekeeping.durationMs)}</span> &nbsp;`
          : hasTiming(arm) ? `Model time (approx., duration minus tool wait): <span>${formatDuration(modelTimeMs(arm))}</span> &nbsp; Tool time: <span>${formatDuration(toolTimeMs(arm))}</span> &nbsp;` : ""}
        Diff: <span>${escapeHtml(formatDiffSummary(arm.diffStats))}</span>
      </div>
    </div>`;
  };

  const slowestRows = (arm: ArmResult) => slowestTools(arm.run.toolCalls, 5).map(tc => `
      <tr>
        <td>${formatDuration(tc.durationMs ?? 0)}</td>
        <td style="font-family: var(--mono); font-size: 12px;">${escapeHtml(toolLabel(tc))}</td>
      </tr>`).join("");

  const maxTime = Math.max(b.run.durationMs, u.run.durationMs, 1);
  const maxCost = Math.max(b.estimatedCost, u.estimatedCost, 0.0001);
  const bOut = b.run.tokenUsage.outputTokens, uOut = u.run.tokenUsage.outputTokens;
  const bCache = b.run.tokenUsage.cacheReadTokens, uCache = u.run.tokenUsage.cacheReadTokens;
  const maxOut = Math.max(bOut, uOut, 1);
  const maxCache = Math.max(bCache, uCache, 1);
  const bModelMs = modelTimeMs(b), uModelMs = modelTimeMs(u);
  const bToolMs = toolTimeMs(b), uToolMs = toolTimeMs(u);

  const barPair = (label: string, bVal: number, uVal: number, max: number, fmt: (n: number) => string, note = "") => {
    const better = uVal <= bVal;
    return `
    <div class="comparison-row">
      <div class="comp-label">${label}${note ? `<div class="comp-note">${note}</div>` : ""}</div>
      <div class="bar-group">
        <div class="bar-row">
          <span class="bar-tag baseline">Baseline</span>
          <div class="bar-track"><div class="bar-fill baseline" style="width: ${barWidth(bVal, max)}%">${fmt(bVal)}</div></div>
        </div>
        <div class="bar-row">
          <span class="bar-tag ${better ? "better" : "worse"}">${L.short}</span>
          <div class="bar-track"><div class="bar-fill ${better ? "better" : "worse"}" style="width: ${barWidth(uVal, max)}%">${fmt(uVal)}</div></div>
        </div>
      </div>
    </div>`;
  };

  const timestamp = new Date().toLocaleString("en-US", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  const perModelRows = (armName: string, arm: ArmResult) =>
    modelEntries(arm.run.tokenUsage).map(([m, mu]) => `
      <tr>
        <td>${escapeHtml(armName)}</td>
        <td>${escapeHtml(modelLabel(m))}</td>
        <td>${formatTokens(mu.inputTokens)}</td>
        <td>${formatTokens(mu.outputTokens)}</td>
        <td>${formatTokens(mu.cacheReadTokens)}</td>
        <td>${formatTokens(mu.cacheCreationTokens)}</td>
        <td>${formatCost(modelCost(m, mu))}${typeof mu.costUsd === "number" ? "" : " (est.)"}</td>
      </tr>`).join("");
  const modelBreakdownRows = perModelRows("Baseline", b) + perModelRows(L.arm, u);

  const modelsUsed = [...new Set([
    ...modelEntries(b.run.tokenUsage).map(([m]) => m),
    ...modelEntries(u.run.tokenUsage).map(([m]) => m),
  ])];
  if (modelsUsed.length === 0) modelsUsed.push(result.model);
  const pricingRows = modelsUsed.map(m => {
    const p = priceFor(m);
    return `
      <tr>
        <td>${escapeHtml(modelLabel(m))}</td>
        <td>$${p.input.toFixed(2)}</td>
        <td>$${p.output.toFixed(2)}</td>
        <td>$${p.cacheRead.toFixed(2)}</td>
        <td>$${p.cacheWrite.toFixed(2)}</td>
        <td>$${p.cacheWrite1h.toFixed(2)}</td>
      </tr>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(L.vs)}</title>
${FONTS}
<style>${REPORT_CSS}</style>
</head>
<body>
<main class="sheet">

  ${ce ? heroHtml : `<header class="masthead">
    <p class="product">Unblocked Compare, ${timestamp}</p>
    <h1>${escapeHtml(L.vs)}</h1>
    ${facts}
  </header>

  <section class="section">
    <h2 class="section-title">Task</h2>
    <blockquote class="task">${escapeHtml(result.task)}</blockquote>
  </section>`}

  ${tldrSection}

  <details class="full-report"${ce ? "" : " open"}>
  <summary>Full report<span>Core work, housekeeping, quality, what the context did, arm details, tools and diffs</span></summary>

  ${hasAttr ? `
  <div class="section">
    <div class="section-title">1 · Core task work <span class="section-sub">${ce ? "the Summary's measured figures" : "the headline figures"}</span></div>
    <div class="section-note">Reading, deciding, coding, testing, and the tool wait they caused. Housekeeping (section 2) is removed from both arms. Time is model time plus tool wait; tokens are every token the model processed: fresh input, cache writes, cache reads and output.</div>
    ${ce ? "" : `<div class="hero-grid hero-3">
      ${heroCard("Cost", b.attribution!.core.costUsd, u.attribution!.core.costUsd, formatCost)}
      ${heroCard("Time", b.attribution!.core.durationMs, u.attribution!.core.durationMs, formatDuration)}
      ${heroCard("Tokens", coreTokens(b), coreTokens(u), formatTokens)}
    </div>`}
    ${barPair("Cost", b.attribution!.core.costUsd, u.attribution!.core.costUsd, maxCost, formatCost)}
    ${barPair("Time", b.attribution!.core.durationMs, u.attribution!.core.durationMs, maxTime, formatDuration, "model time + tool wait")}
    ${hasCoreTiming ? barPair("Model time", coreModelTimeMs(b), coreModelTimeMs(u), maxTime, formatDuration, "thinking and generation") : ""}
    ${hasCoreTiming ? barPair("Tool wait", coreToolTimeMs(b), coreToolTimeMs(u), maxTime, formatDuration, "tests, builds, research, shell: set by what each agent chose to run") : ""}
    ${barPair("Tokens", coreTokens(b), coreTokens(u), Math.max(coreTokens(b), coreTokens(u), 1), formatTokens, "input + cache write + cache read + output")}
    ${barPair("Cache-read tokens", b.attribution!.core.cacheReadTokens, u.attribution!.core.cacheReadTokens, Math.max(coreTokens(b), coreTokens(u), 1), formatTokens, "context re-read each message; most of the total, priced at a tenth of input")}
    ${barPair("Output tokens", b.attribution!.core.outputTokens, u.attribution!.core.outputTokens, Math.max(b.attribution!.core.outputTokens, u.attribution!.core.outputTokens, 1), formatTokens, "what the model wrote; the most expensive tokens")}
    ${barPair("Messages", b.attribution!.core.turns, u.attribution!.core.turns, Math.max(b.attribution!.core.turns, u.attribution!.core.turns, 1), String)}
    ${result.economics ? economicsBlock(result) : ""}
  </div>

  <div class="section">
    <div class="section-title">2 · Housekeeping <span class="section-sub">excluded from every figure above</span></div>
    <div class="section-note">Housekeeping: lockfile reverts, artifact cleanup, status checks, branching, committing, redundant reruns. Model habit, not context, so it counts in neither arm. Tool wait during core work is part of the core time; it is shown here for reference. Raw total is the whole run, housekeeping included.</div>
    <div class="tool-table-wrap">
      <table class="tool-table">
        <thead><tr><th>Arm</th><th>Housekeeping msgs</th><th>Cost</th><th>Time</th><th>What it was</th><th>Tool wait in core work</th><th>Raw total</th></tr></thead>
        <tbody>
          <tr><td>Baseline</td><td>${b.attribution!.housekeeping.turns}</td><td>${formatCost(b.attribution!.housekeeping.costUsd)}</td><td>${formatDuration(b.attribution!.housekeeping.durationMs)}</td><td>${escapeHtml(housekeepingKinds(b)) || "–"}</td><td>${formatDuration(coreToolTimeMs(b))}</td><td>${formatCost(b.estimatedCost)} · ${formatDuration(b.run.durationMs)}</td></tr>
          <tr><td>${L.arm}</td><td>${u.attribution!.housekeeping.turns}</td><td>${formatCost(u.attribution!.housekeeping.costUsd)}</td><td>${formatDuration(u.attribution!.housekeeping.durationMs)}</td><td>${escapeHtml(housekeepingKinds(u)) || "–"}</td><td>${formatDuration(coreToolTimeMs(u))}</td><td>${formatCost(u.estimatedCost)} · ${formatDuration(u.run.durationMs)}</td></tr>
        </tbody>
      </table>
    </div>
    ${stallNote(b, u)}
    <details class="ledger"><summary>Excluded turns, with reasons</summary>
      ${housekeepingLedger("Baseline", b)}
      ${housekeepingLedger(L.arm, u)}
    </details>
  </div>` : `
  <div class="hero-grid">
    ${heroCard("Speed", b.run.durationMs, u.run.durationMs, formatDuration)}
    ${heroCard("Cost", b.estimatedCost, u.estimatedCost, formatCost)}
  </div>
  <div class="section">
    <div class="section-title">Head-to-Head (raw)</div>
    ${barPair("Duration", b.run.durationMs, u.run.durationMs, maxTime, formatDuration)}
    ${barPair("Est. Cost", b.estimatedCost, u.estimatedCost, maxCost, formatCost)}
    ${barPair("Output tokens", bOut, uOut, maxOut, formatTokens, "what the model wrote")}
    ${barPair("Cache-read tokens", bCache, uCache, maxCache, formatTokens, "context re-read per turn; 2% of output price")}
  </div>`}

  ${b.review || u.review ? `
  <div class="section">
    <div class="section-title">Requirement check and fix rounds <span class="section-sub">checker ${escapeHtml((b.review ?? u.review)!.passes[0]?.reviewModel ?? "")}, up to ${(b.review ?? u.review)!.maxRounds} round(s)</span></div>
    <div class="section-note">One requirement list for the run, extracted from the task before either arm started. After each pass a checker marks every requirement met, partial or unmet with the reason; it adds nothing and suggests nothing. The agent resumes its session to meet the open ones, and may dispute one; a dispute is decided once, blind to the arm, and a waiver applies to both. Rounds stop when every requirement is met or waived. Numbers elsewhere on this page include every fix pass.</div>
    ${sharedRequirementsTable(result)}
    ${[["Baseline", b], [L.arm, u]].map(([label, arm]) => {
      const rv = (arm as ArmResult).review;
      if (!rv) return "";
      const last = rv.passes[rv.passes.length - 1];
      return `
      <div class="arm-section">
        <div class="arm-header"><span class="arm-name">${escapeHtml(label as string)} <span class="met ${rv.finalMergeable ? "met-met" : rv.checkFailed ? "met-partial" : "met-unmet"}">${rv.finalMergeable ? "all requirements met" : rv.checkFailed ? `check failed in round ${rv.checkFailed}; last recorded state below` : "requirements open"}</span></span>
          <span style="font-size: 12px; color: var(--text-muted);">draft ${escapeHtml(formatDiffSummary(rv.draft.diffStats))} → final ${escapeHtml(formatDiffSummary((arm as ArmResult).diffStats))} · ${rv.passes.filter(p => p.fix).length} fix pass(es), ${formatCost(rv.passes.reduce((s2, p) => s2 + (p.fix?.costUsd ?? 0), 0))}, ${formatDuration(rv.passes.reduce((s2, p) => s2 + (p.fix?.durationMs ?? 0), 0))}</span></div>
        ${last && !result.reviewSpec ? `<table class="tool-table"><thead><tr><th>Requirement</th><th>Final status</th></tr></thead><tbody>${last.requirements.map(r => `
          <tr><td>${escapeHtml(r.requirement)}</td><td><span class="met ${r.status === "met" ? "met-met" : r.status === "unmet" ? "met-unmet" : "met-partial"}">${r.status}</span><div class="evidence">${escapeHtml(r.note)}</div></td></tr>`).join("")}</tbody></table>` : ""}
        ${rv.passes.map(p => `
        <div class="arm-tokens" style="display:block;"><b>Round ${p.round}</b> · ${p.mergeable ? "all met" : "open"} · ${escapeHtml(p.summary)}${p.fix ? ` · fix: ${formatCost(p.fix.costUsd)}, ${formatDuration(p.fix.durationMs)}, ${p.fix.messages} msgs${p.fix.disputed ? ` · <span class="met met-partial">disputed</span> ${escapeHtml(p.fix.disputed.slice(0, 200))}` : ""}` : ""}
          ${p.comments?.length ? `<table class="tool-table" style="margin-top: 6px;"><tbody>${p.comments.map(c => `
            <tr><td style="width: 90px;"><span class="met ${c.severity === "must-fix" ? "met-unmet" : c.severity === "should-fix" ? "met-partial" : ""}">${c.severity}</span></td><td style="font-family: var(--mono); font-size: 12px; width: 220px;">${escapeHtml(c.file.split("/").slice(-2).join("/"))}</td><td style="font-size: 13px;">${escapeHtml(c.comment)}</td></tr>`).join("")}</tbody></table>` : ""}
        </div>`).join("")}
      </div>`;
    }).join("")}
  </div>` : ""}

  ${result.quality ? `
  <div class="section">
    <div class="section-title">3 · Quality analysis <span class="section-sub">blinded judge: ${escapeHtml(result.quality.judgeModel)}</span></div>
    <div class="section-note">Blinded judge: saw task, final responses, tests run, diffs and the checker's final record as A/B in random order. Grades the same requirement list as the checker, after the revision pass: a requirement is restated to the team's intent only when one agent's tool results quote the decision, and both agents are graded against the restatement. Its verdict is decided by requirements met, then by defects the change introduces within that scope, then by material hygiene; other work beyond the task does not count. A blinded tie goes to ${L.short} only when the ${L.short} agent's candidate discovery materially improved the outcome or invalidated a requirement, and the un-blinded impact pass finds the research context led to it. Discoveries the agent made on its own, on either side, measure model variance and never break a tie.</div>
    <div class="verdict ${result.quality.verdict.better === "unblocked" ? "positive" : result.quality.verdict.better === "baseline" ? "negative" : ""}">
      <div class="verdict-head">Verdict: ${result.quality.verdict.better === "tie" ? "tie" : result.quality.verdict.better === "unblocked" ? L.arm : "Baseline"}${result.quality.verdict.tieBreaker?.applied ? ` <span class="verdict-conf">· blinded verdict was a tie; decided by the context-led discovery tie-breaker</span>` : result.impact ? ` <span class="verdict-conf">· driver: ${result.impact.impact.outcomeDriver === "context" ? "the Unblocked context" : result.impact.impact.outcomeDriver === "agent" ? "agent behaviour, not context" : "context and agent behaviour"}</span>` : ""}</div>
      <div>${escapeHtml(result.quality.verdict.rationale)}</div>
      ${result.quality.verdict.tieBreaker ? `<div class="evidence" style="margin-top: 6px;">Tie-breaker: ${result.quality.verdict.tieBreaker.applied ? "applied" : "not applied"} · ${escapeHtml(result.quality.verdict.tieBreaker.reason)}</div>` : ""}
    </div>
    ${result.quality.discoveries ? `<div class="findings" style="margin-bottom: 16px;">${(["baseline", "unblocked"] as const).map(a => {
      const d = result.quality!.discoveries![a];
      const label = a === "baseline" ? "Baseline" : L.arm;
      if (d.kind === "none") return `<div class="finding"><b>${label}</b> · candidate discovery: none</div>`;
      const attr = a === "unblocked" ? result.impact?.discoveryAttribution : undefined;
      const tag = a === "baseline" ? `<span class="met met-partial">agent-found; baseline has no context, so it cannot break a tie</span>`
        : attr ? (attr.contextLed ? `<span class="met met-met">led by the context</span>` : `<span class="met met-partial">not led by the context</span>`) : "";
      return `<div class="finding"><b>${label}</b> · candidate discovery: ${d.kind === "improved-outcome" ? "improved the outcome" : `invalidated requirement ${(d.requirementIndex ?? 0) + 1} for both agents`} ${tag}<div style="margin-top: 4px;">${escapeHtml(d.fact)} &rarr; ${escapeHtml(d.effect)}</div><div class="evidence">${escapeHtml(d.evidence)}${attr && a === "unblocked" ? ` · attribution: ${escapeHtml(attr.evidence)}` : ""}</div></div>`;
    }).join("")}</div>` : ""}
    <div class="tool-table-wrap" style="margin-bottom: 16px;">
      <table class="tool-table">
        <thead><tr><th>Requirement from the task</th><th>Baseline</th><th>${L.arm}</th></tr></thead>
        <tbody>${result.quality.requirements.map(rq => `
          <tr>
            <td>${escapeHtml(rq.requirement)}${revisionNote(result, rq)}</td>
            <td><span class="met met-${rq.baseline.status}">${MET_ICON[rq.baseline.status]} ${rq.baseline.status}</span><div class="evidence">${escapeHtml(rq.baseline.evidence)}</div></td>
            <td><span class="met met-${rq.unblocked.status}">${MET_ICON[rq.unblocked.status]} ${rq.unblocked.status}</span><div class="evidence">${escapeHtml(rq.unblocked.evidence)}</div></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <div class="tool-table-wrap" style="margin-bottom: 16px;">
      <table class="tool-table">
        <thead><tr><th>Criterion</th><th>Baseline</th><th>${L.arm}</th></tr></thead>
        <tbody>${result.quality.criteria.map(c => `
          <tr>
            <td>${escapeHtml(c.criterion)}</td>
            <td><span class="score">${c.baseline.score}/5</span><div class="evidence">${escapeHtml(c.baseline.rationale)}</div></td>
            <td><span class="score">${c.unblocked.score}/5</span><div class="evidence">${escapeHtml(c.unblocked.rationale)}</div></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
    ${result.quality.findings.length ? `<div class="findings">${result.quality.findings.map(f => `
      <div class="finding"><span class="finding-arm ${f.arm}">${f.arm === "unblocked" ? L.arm : "Baseline"}</span> ${escapeHtml(f.finding)}<div class="evidence">${escapeHtml(f.evidence)}</div></div>`).join("")}</div>` : ""}
  </div>` : ""}

  ${result.impact ? `
  <div class="section">
    <div class="section-title">4 · ${L.impactTitle} <span class="section-sub">un-blinded: ${escapeHtml(result.impact.model)}</span></div>
    <div class="section-note">Which research results the agent used, and whether the outcome traces to the context or to the agent.</div>
    <div class="verdict ${result.impact.impact.contextEffect === "helped" ? "positive" : result.impact.impact.contextEffect === "hurt" ? "negative" : ""}">
      <div class="verdict-head">Outcome: ${result.impact.impact.outcome} <span class="verdict-conf">· context ${result.impact.impact.contextEffect} · driven by ${result.impact.impact.outcomeDriver}</span></div>
      <div>${escapeHtml(result.impact.impact.summary)}</div>
      <div style="margin-top: 8px;"><strong>What would most have changed the result:</strong> ${escapeHtml(result.impact.impact.whatWouldChange)}</div>
      ${result.impact.loss && result.impact.loss.unblockedFailure !== "n/a" ? `<div style="margin-top: 8px;"><strong>Why baseline won:</strong> ${escapeHtml(result.impact.loss.unblockedFailure)}${result.impact.loss.baselineFound ? ` — baseline found ${escapeHtml(result.impact.loss.baselineFound)} (${escapeHtml(result.impact.loss.howFound)})` : ""}. ${escapeHtml(result.impact.loss.explanation)}</div>` : ""}
    </div>
    <div class="tool-table-wrap">
      <table class="tool-table">
        <thead><tr><th>Research call</th><th>Returned</th><th>Used</th><th>Value</th></tr></thead>
        <tbody>${result.impact.research.map(rc => `
          <tr>
            <td>T${rc.turn} · ${escapeHtml(rc.query.slice(0, 120))}<div class="evidence">${escapeHtml(rc.note)}</div></td>
            <td>${rc.itemsReturned}</td>
            <td>${rc.itemsUsed.length ? rc.itemsUsed.map(x => `<div><b>${escapeHtml(x.item.slice(0, 60))}</b> <span class="evidence" style="display:inline">${escapeHtml(x.use)}</span></div>`).join("") : `<span style="color: var(--text-muted)">none</span>`}</td>
            <td><span class="met ${rc.value === "decisive" || rc.value === "useful" ? "met-met" : rc.value === "misleading" ? "met-unmet" : "met-partial"}">${rc.value}</span></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
  </div>` : ""}

  <div class="section">
    <div class="section-title">Arm Details</div>

    ${armCard("Baseline", b, false)}
    ${armCard(L.arm, u, true)}
  </div>

  ${modelBreakdownRows ? `
  <div class="section">
    <div class="section-title">Per-Model Breakdown</div>
    <div class="tool-table-wrap">
      <table class="tool-table">
        <thead><tr><th>Arm</th><th>Model</th><th>Fresh Input</th><th>Output</th><th>Cache Read</th><th>Cache Write</th><th>Est. Cost</th></tr></thead>
        <tbody>${modelBreakdownRows}</tbody>
      </table>
    </div>
  </div>` : ""}

  <div class="section">
    <div class="section-title">Pricing &mdash; $ per million tokens <span class="section-sub">${b.run.costEstimated || u.run.costEstimated ? "arm costs marked (est.) were priced from this table because the CLI reported no billed total for at least one pass" : "reference only; arm costs are what the CLI billed"}</span></div>
    <div class="tool-table-wrap">
      <table class="tool-table">
        <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cache Write (5m)</th><th>Cache Write (1h)</th></tr></thead>
        <tbody>${pricingRows}</tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Tool Usage Breakdown</div>
    <div class="tool-table-wrap">
      <table class="tool-table">
        <thead><tr><th>Tool</th><th>Baseline</th><th>${L.short}</th><th>Delta</th>${hasToolTiming ? `<th>Baseline time</th><th>${L.short} time</th>` : ""}</tr></thead>
        <tbody>${toolCompareRows}</tbody>
      </table>
    </div>
    ${[["Baseline", b], [L.short, u]].filter(([, a]) => shellOnlyEdits(a as ArmResult)).map(([n, a]) => `
    <div style="font-size: 12px; color: var(--text-muted); margin-top: 8px;">
      ${n} changed ${(a as ArmResult).diffStats.filesChanged} file${(a as ArmResult).diffStats.filesChanged === 1 ? "" : "s"} without any Edit/Write call — see "Bash (writes files)" for the shell commands that did it. The diff below is the ground truth.
    </div>`).join("")}
  </div>

  ${hasToolTiming ? `
  <div class="section">
    <div class="section-title">Slowest Tool Calls</div>
    <div class="hero-grid">
      <div class="tool-table-wrap">
        <table class="tool-table">
          <thead><tr><th colspan="2">Baseline</th></tr></thead>
          <tbody>${slowestRows(b)}</tbody>
        </table>
      </div>
      <div class="tool-table-wrap">
        <table class="tool-table">
          <thead><tr><th colspan="2">${L.arm}</th></tr></thead>
          <tbody>${slowestRows(u)}</tbody>
        </table>
      </div>
    </div>
  </div>` : ""}

  ${u.unblockedCalls.length > 0 ? `
  <div class="section">
    <div class="section-title">${L.queries}</div>
    <div class="unblocked-grid">
      ${u.unblockedCalls.map(c => `
        <div class="unblocked-card">
          <span class="unblocked-tool">${escapeHtml(c.tool)}</span>
          ${c.query ? `<span class="unblocked-query">${escapeHtml(c.query.slice(0, 200))}</span>` : ""}
        </div>
      `).join("")}
    </div>
  </div>` : ""}

  ${engineSection(u)}

  <div class="section">
    <div class="section-title">Code Changes &mdash; Baseline</div>
    <div class="diff-summary">
      <span>${b.diffStats.filesChanged} files</span>
      <span class="diff-added">+${b.diffStats.linesAdded}</span>
      <span class="diff-removed">-${b.diffStats.linesRemoved}</span>
      ${b.diffStats.commits ? `<span>${b.diffStats.commits} commit${b.diffStats.commits === 1 ? "" : "s"} by agent (included)</span>` : ""}
      ${b.diffStats.truncated ? `<span>diff text truncated</span>` : ""}
    </div>
    <div class="diff-block"><pre><code>${formatDiff(b.diff)}</code></pre></div>
  </div>

  <div class="section">
    <div class="section-title">Code Changes &mdash; ${L.arm}</div>
    <div class="diff-summary">
      <span>${u.diffStats.filesChanged} files</span>
      <span class="diff-added">+${u.diffStats.linesAdded}</span>
      <span class="diff-removed">-${u.diffStats.linesRemoved}</span>
      ${u.diffStats.commits ? `<span>${u.diffStats.commits} commit${u.diffStats.commits === 1 ? "" : "s"} by agent (included)</span>` : ""}
      ${u.diffStats.truncated ? `<span>diff text truncated</span>` : ""}
    </div>
    <div class="diff-block"><pre><code>${formatDiff(u.diff)}</code></pre></div>
  </div>
  </details>

  <footer class="footer">Generated by Unblocked Compare. <a href="https://getunblocked.com">getunblocked.com</a></footer>

</main>
${COUNT_UP}
</body>
</html>`;

  const htmlPath = path.join(outDir, "report.html");
  fs.writeFileSync(htmlPath, html);
  return htmlPath;
}

// Console TL;DR: headline, the three numbers raw and with confounders removed.
function tldrLines(result: ComparisonResult): string[] {
  const ce = result.contextEffect;
  if (!ce) return [];
  const pct = (a: number, b: number) => (a ? `${b >= a ? "+" : ""}${Math.round(((b - a) / a) * 100)}%` : "n/a");
  const sg = (n: number, fmt: (n: number) => string) => `${n < 0 ? "-" : "+"}${fmt(Math.abs(n))}`;
  const row = (name: string, raw: [number, number], adj: [number, number], fmt: (n: number) => string) => {
    const r = reconcile(ce, name === "Cost" ? "costUsd" : name === "Time" ? "durationMs" : "tokens");
    return `  ${padRight(name, 8)}context's influence ${padLeft(pct(adj[0], adj[1]), 5)}  measured ${padLeft(pct(raw[0], raw[1]), 5)} = ${sg(r.influence, fmt)} influence ${sg(r.ownMistakes, fmt)} own mistakes ${sg(r.other, fmt)} other`;
  };
  return [
    "",
    ...wrap("SUMMARY" + (ce.tldr ? `: ${ce.tldr.headline}` : ""), W - 8).map(l => `  ${l}`),
    row("Cost", [ce.baseline.costUsd, ce.unblocked.costUsd], [ce.adjustedBaseline.costUsd, ce.adjustedUnblocked.costUsd], formatCost),
    row("Time", [ce.baseline.durationMs, ce.unblocked.durationMs], [ce.adjustedBaseline.durationMs, ce.adjustedUnblocked.durationMs], formatDuration),
    row("Tokens", [ce.baseline.tokens, ce.unblocked.tokens], [ce.adjustedBaseline.tokens, ce.adjustedUnblocked.tokens], formatTokens),
    ...(ce.tldr?.bullets ?? []).flatMap(b => wrap(b, W - 10).map((l, i) => `   ${i ? " " : "•"} ${l}`)),
    "",
  ];
}

// The simulated context engine's research calls: what each cost and took.
// Its spend stands in for the real service's, so it is not in the arm's cost.
function engineSection(arm: ArmResult): string {
  const e = arm.contextEngine;
  if (!e) return "";
  const modified = e.calls.some(c => c.repoModified);
  const rows = e.calls.map(c => `
        <tr>
          <td>${c.seq}</td>
          <td>${escapeHtml(c.command)}${c.effort ? ` <span style="color: var(--text-muted);">(${escapeHtml(c.effort)})</span>` : ""}</td>
          <td style="font-size: 13px;">${escapeHtml((c.query ?? (c.urls ?? []).join(" ")).slice(0, 220))}</td>
          <td>${formatDuration(c.durationMs)}</td>
          <td>${formatCost(c.costUsd)}</td>
          <td>${c.toolCalls}</td>
          <td>${c.error ? `<span style="color: var(--red);">${escapeHtml(c.error)}</span>` : c.repoModified ? `<span style="color: var(--yellow);">modified repo</span>` : `<span style="color: var(--green);">ok</span>`}</td>
        </tr>`).join("");
  return `
  <div class="section">
    <div class="section-title">Simulated context engine <span class="section-sub">${e.calls.length} call(s) · ${formatDuration(e.durationMs)} · ${formatCost(e.costUsd)}</span></div>
    <div class="section-note">The ${L.short} arm's <code>unblocked</code> CLI was a local research agent (the same agent CLI, with its MCP servers and read-only) answering each query in the original repository. Its cost stands in for the context engine's and is not included in the arm's cost. A simulated research pass takes far longer than the real service, so each call counts as at most ${formatDuration(e.capMs ?? 20_000)} in the arm's timings${e.discountedMs ? `: ${formatDuration(e.discountedMs)} removed` : ""}; the time column below is the actual. Transcripts: <code>unblocked/engine/research-*.jsonl</code>.${modified ? ` <span style="color: var(--yellow);">A research call changed files in the repository; check <code>git status</code> there.</span>` : ""}</div>
    ${e.calls.length ? `<div class="tool-table-wrap">
      <table class="tool-table">
        <thead><tr><th>#</th><th>Command</th><th>Query</th><th>Time</th><th>Cost</th><th>Tools</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : `<div class="section-note">The agent made no research calls.</div>`}
  </div>`;
}

// A requirement the revision pass restated: the task's wording, who found the
// team's intent, and the quote from that arm's tool results that shows it.
function revisionNote(result: ComparisonResult, rq: { index?: number; revisedFrom?: string }): string {
  const rev = rq.index !== undefined ? result.reviewSpec?.revisions?.find(r => r.index === rq.index) : undefined;
  if (!rev || !rq.revisedFrom) return "";
  const by = rev.foundBy === "unblocked" ? L.arm : "Baseline";
  return `<div class="evidence"><b>Revised</b> from the task's wording "${escapeHtml(rq.revisedFrom)}" — ${escapeHtml(rev.reason)} Found by ${escapeHtml(by)}: <i>"${escapeHtml(rev.quote)}"</i></div>`;
}

// Arm and section names: a simulation's treatment arm is the simulated
// context, not Unblocked. Set at the start of each report writer.
interface Labels { short: string; arm: string; baseline: string; vs: string; impactTitle: string; queries: string }
function labelsFor(r?: { contextEngine?: string }): Labels {
  const sim = r?.contextEngine === "simulated";
  const short = sim ? "Simulated Context" : "Unblocked";
  return { short, arm: `With ${short}`, baseline: sim ? "Baseline" : "Baseline (no Unblocked)", vs: `Baseline vs ${short}`, impactTitle: sim ? "What the simulated context did" : "What the Unblocked context did", queries: sim ? "Simulated Context Queries" : "Unblocked Context Queries" };
}
let L: Labels = labelsFor();

// Results from before the agent was recorded were all Claude Code runs.
function agentLabel(result: { agent?: AgentName }): string {
  return AGENTS[result.agent ?? "claude"].label;
}

export function writeBatchSummary(config: { agent: AgentName; task: string; repo: string; branch: string; model: string; repeat: number }, results: ComparisonResult[], batchDir: string): string {
  L = labelsFor(results[0]);
  const median = (xs: number[]) => { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y); return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
  const core = (r: ComparisonResult, arm: "baseline" | "unblocked") => r[arm].attribution?.core ?? { costUsd: r[arm].estimatedCost, durationMs: r[arm].run.durationMs, turns: r[arm].run.assistantTurns };
  const counts = { unblocked: 0, baseline: 0, tie: 0, none: 0 };
  for (const r of results) { const v = r.quality?.verdict.better; if (v === "unblocked" || v === "baseline" || v === "tie") counts[v]++; else counts.none++; }
  const judged = results.filter(r => r.quality);
  if (judged.length < results.length) console.error(`Batch summary: ${results.length - judged.length} of ${results.length} run(s) had no verdict (killed/void) and are excluded from the medians, shown as "–" in the table`);
  const med = (arm: "baseline" | "unblocked", f: (c: ReturnType<typeof core>) => number) => median(judged.map(r => f(core(r, arm))));
  const pct = (b: number, u: number) => b > 0 ? `${u >= b ? "+" : ""}${Math.round((u / b - 1) * 100)}%` : "n/a";
  const rows = results.map((r, i) => {
    const b = core(r, "baseline"), u = core(r, "unblocked");
    const dir = path.join(batchDir, `run-${i + 1}`);
    const v = r.quality?.verdict;
    return `<tr><td><a href="run-${i + 1}/report.html">run ${i + 1}</a></td><td>${v ? (v.better === "unblocked" ? L.arm : v.better === "baseline" ? "Baseline" : "tie") : "–"}${v?.tieBreaker?.applied ? " <span class=\"met met-met\">tie-breaker</span>" : ""}</td><td>${r.impact ? escapeHtml(r.impact.impact.outcomeDriver) : "–"}</td><td>${formatCost(b.costUsd)} to ${formatCost(u.costUsd)} (${pct(b.costUsd, u.costUsd)})</td><td>${formatDuration(b.durationMs)} to ${formatDuration(u.durationMs)} (${pct(b.durationMs, u.durationMs)})</td><td>${b.turns} to ${u.turns}</td><td class="evidence">${escapeHtml(v?.rationale ?? "")}</td></tr>`;
  });
  const bC = med("baseline", c => c.costUsd), uC = med("unblocked", c => c.costUsd), bT = med("baseline", c => c.durationMs), uT = med("unblocked", c => c.durationMs);
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(L.vs)}: ${results.length} runs</title>
${FONTS}
<style>${REPORT_CSS}${BATCH_CSS}</style></head><body><main class="sheet">
  <header class="masthead">
    <p class="product">Unblocked Compare, batch of ${results.length}${results.length < config.repeat ? ` (of ${config.repeat} planned)` : ""}</p>
    <h1>${escapeHtml(L.vs)}</h1>
    <dl class="facts">
      <div><dt>Repository</dt><dd>${escapeHtml(repoName(config.repo))}</dd></div>
      <div><dt>Branch</dt><dd>${escapeHtml(config.branch)}</dd></div>
      <div><dt>Agent</dt><dd>${escapeHtml(agentLabel(config))}</dd></div>
      <div><dt>Model</dt><dd>${escapeHtml(config.model)}</dd></div>
    </dl>
  </header>
  <section class="section">
    <h2 class="section-title">Task</h2>
    <blockquote class="task">${escapeHtml(config.task.slice(0, 600))}${config.task.length > 600 ? "…" : ""}</blockquote>
  </section>
  <section class="section">
    <h2 class="section-title">Across runs</h2>
    <table class="results">
      <tbody>
        <tr><th scope="row">Verdicts</th><td><span class="fig">${counts.unblocked} / ${counts.tie} / ${counts.baseline}</span><span class="range">${escapeHtml(L.short)} better / tie / Baseline better${counts.none ? `; ${counts.none} without a verdict` : ""}</span></td></tr>
        <tr><th scope="row">Median core cost</th><td><span class="fig ${uC <= bC ? "better" : "worse"}">${pct(bC, uC).replace(/^-/, "&minus;")}</span><span class="range">${formatCost(bC)} to ${formatCost(uC)}</span></td></tr>
        <tr><th scope="row">Median core time</th><td><span class="fig ${uT <= bT ? "better" : "worse"}">${pct(bT, uT).replace(/^-/, "&minus;")}</span><span class="range">${formatDuration(bT)} to ${formatDuration(uT)}</span></td></tr>
      </tbody>
    </table>
  </section>
  <section class="section">
    <h2 class="section-title">Runs</h2>
    <div class="tool-table-wrap"><table class="tool-table"><thead><tr><th>Run</th><th>Verdict</th><th>Driver</th><th>Core cost</th><th>Core time</th><th>Messages</th><th>Rationale</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
    <p class="section-note">Each run is an independent comparison (fresh clones, its own requirement check, judge and impact pass). Costs and times read Baseline to ${escapeHtml(L.short)}. Medians are over core work with housekeeping removed, across the ${judged.length} of ${results.length} run(s) that reached a verdict${judged.length < results.length ? " (a killed or timed-out run's partial spend is not comparable and is excluded)" : ""}. Verdicts follow the same rubric as the per-run reports.</p>
  </section>
</main></body></html>`;
  const out = path.join(batchDir, "summary.html");
  fs.writeFileSync(out, html);
  fs.writeFileSync(path.join(batchDir, "summary.json"), JSON.stringify({ config, verdicts: counts, medians: { baseline: { costUsd: bC, durationMs: bT }, unblocked: { costUsd: uC, durationMs: uT } }, runs: results.map((r, i) => ({ dir: `run-${i + 1}`, verdict: r.quality?.verdict, driver: r.impact?.impact.outcomeDriver, baseline: core(r, "baseline"), unblocked: core(r, "unblocked") })) }, null, 2));
  return out;
}
