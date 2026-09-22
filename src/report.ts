import fs from "node:fs";
import path from "node:path";
import type { ArmResult, ComparisonResult, Met, ToolCall } from "./types.ts";
import { formatCost, formatDiffSummary, formatDuration, formatTokens, modelCost, padLeft, padRight, priceFor, totalTokens, uncachedTokens } from "./util.ts";
import type { TokenUsage } from "./types.ts";

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
    if (/^unblocked\s+/.test(cmd)) return "Unblocked";
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
    const cost = a.waived ? [["Baseline", result.baseline], ["With Unblocked", result.unblocked]].map(([n, arm]) => [n, paidFor(arm as ArmResult, a.index)] as const).filter(([, k]) => k > 0).map(([n, k]) => `${n} had already spent ${k} fix pass(es) on it before the waiver`).join("; ") : "";
    return `<li>Requirement ${a.index + 1}, disputed by ${a.disputedBy === "unblocked" ? "the Unblocked arm" : "the baseline arm"} in round ${a.round}: <b>${a.waived ? "waived for both arms" : a.excludes ? `stands, but does not cover ${escapeHtml(a.excludes)} (both arms)` : "dispute rejected"}</b>. ${escapeHtml(a.reason)}${cost ? ` <span class="met met-partial">${escapeHtml(cost)}</span>` : ""}</li>`;
  }).join("");
  return `<div class="tool-table-wrap"><table class="tool-table">
      <thead><tr><th>Requirement (same list for both arms)</th><th>Baseline</th><th>With Unblocked</th></tr></thead>
      <tbody>${spec.requirements.map((req, i) => `<tr><td>${i + 1}. ${escapeHtml(req)}</td>${cell(result.baseline, i)}${cell(result.unblocked, i)}</tr>`).join("")}</tbody>
    </table></div>${adj ? `<ul class="section-note" style="margin: 8px 0 0 18px;">${adj}</ul>` : ""}`;
}

function stallNote(b: ArmResult, u: ArmResult): string {
  const bs = b.attribution?.raw.stallMs ?? 0, us = u.attribution?.raw.stallMs ?? 0;
  if (bs <= 0 && us <= 0) return "";
  return `<div class="section-note">Stalled time excluded from all figures: baseline ${formatDuration(bs)}, with Unblocked ${formatDuration(us)}. A model wait longer than five minutes is the machine asleep or the API down, not generation.</div>`;
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
  const b = result.baseline;
  const u = result.unblocked;

  const lines: string[] = [
    "",
    "╔" + "═".repeat(W + 2) + "╗",
    r("  CLAUDE HARNESS — COMPARISON"),
    divider(),
    r(`  Repo:     ${repoName(result.repo)}`),
    r(`  Branch:   ${result.branch}`),
    r(`  Model:    ${result.model}`),
    r(`  Task:     ${result.task.slice(0, 60)}${result.task.length > 60 ? "..." : ""}`),

    divider(),
    blank(),
    ...armSummary("Baseline (no Unblocked)", b).map(s => r(s)),

    blank(),
    ...armSummary("With Unblocked", u).map(s => r(s)),

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
      r(`  ${padRight("Unblocked", 28)}${padLeft(String(u.attribution.housekeeping.turns), 4)} turns  ${padLeft(formatCost(u.attribution.housekeeping.costUsd), 9)}  ${padLeft(formatDuration(u.attribution.housekeeping.durationMs), 8)}  ${housekeepingKinds(u).slice(0, 40)}`),
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
    const para = (title: string, text: string | undefined, facts: string) => `
      <div class="finding" style="margin-bottom: 8px;"><b>${title}</b>${text ? `<div style="margin-top: 4px;">${escapeHtml(text)}</div>` : ""}<div class="evidence" style="margin-top: 6px;">${facts}</div></div>`;
    const toolKinds = Object.entries(e.time.toolWaitDelta).filter(([, v]) => Math.abs(v) >= 1000).sort((a, b2) => Math.abs(b2[1]) - Math.abs(a[1])).map(([k, v]) => `${escapeHtml(k)} ${min(v)}`).join(", ");
    return `
    <div class="section-title" style="font-size: 15px; margin-top: 24px;">Explanation of numbers <span class="section-sub">Unblocked relative to baseline${e.basis === "raw" ? "; whole-run figures, attribution missing for at least one arm" : ""}</span></div>
    <div class="findings">
      ${para("Cost " + usd(e.cost.deltaUsd), ex?.cost, `output ${usd(e.cost.terms.output)} · cache-read ${usd(e.cost.terms.cacheRead)} · cache-write ${usd(e.cost.terms.cacheWrite)} · input ${usd(e.cost.terms.input)}${Math.abs(e.cost.unexplainedUsd) >= 0.01 ? ` · residual ${usd(e.cost.unexplainedUsd)}` : ""}`)}
      ${para("Time " + min(e.time.deltaMs), ex?.time, `model time ${min(e.time.modelDeltaMs)} · tool wait ${min(e.time.toolDeltaMs)}${toolKinds ? ` (${toolKinds})` : ""}`)}
      ${para("Tokens: output " + tok(e.output.deltaTokens) + ", cache-read " + tok(e.cacheRead.deltaTokens), ex?.tokens, `output = thinking ${tok(e.output.thinkingDelta)} + visible ${tok(e.output.visibleDelta)} · cache-read: research context carried ≈ ${tok(e.cacheRead.researchCarriedTokens)}, average context per message ${tok(e.cacheRead.contextPerMessageDelta)}, messages ${e.cacheRead.messagesDelta >= 0 ? "+" : ""}${e.cacheRead.messagesDelta} · Unblocked research: ${e.unblocked.research.calls} calls, ≈${formatTokens(e.unblocked.research.payloadTokens)} tokens returned`)}
    </div>`;
  };

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
            <td style="font-family: 'SF Mono', 'Fira Code', Consolas, monospace; font-size: 12px;">${escapeHtml(t.summary)}</td>
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
      ? { dur: a.core.durationMs, cost: a.core.costUsd, out: a.core.outputTokens, turns: a.core.turns, tag: "core" }
      : { dur: arm.run.durationMs, cost: arm.estimatedCost, out: t.outputTokens, turns: arm.run.assistantTurns, tag: "" };
    return `
    <div class="arm-section"${accent ? ` style="border-color: rgba(59, 130, 246, 0.3);"` : ""}>
      <div class="arm-header"${accent ? ` style="border-bottom-color: rgba(59, 130, 246, 0.2);"` : ""}>
        <span class="arm-name">${escapeHtml(label)}${arm.run.killedReason ? ` <span style="color: var(--red); font-size: 12px;">(KILLED: ${escapeHtml(arm.run.killedReason)})</span>` : arm.run.timedOut ? ` <span style="color: var(--yellow); font-size: 12px;">(TIMED OUT)</span>` : ""}</span>
        ${a ? `<span style="font-size: 12px; color: var(--text-muted);">core task work · raw incl. housekeeping: ${formatCost(arm.estimatedCost)}, ${formatDuration(arm.run.durationMs)}, ${formatTokens(t.outputTokens)} out</span>` : ""}
      </div>
      <div class="arm-meta">
        <div class="arm-stat"><div class="arm-stat-val">${formatDuration(head.dur)}</div><div class="arm-stat-label">${head.tag} Duration</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${has ? formatCost(head.cost) : "N/A"}${arm.run.costEstimated ? ` <span style="font-size: 11px; color: var(--yellow);">(est.)</span>` : ""}</div><div class="arm-stat-label">${head.tag} Cost</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${has ? formatTokens(head.out) : "N/A"}</div><div class="arm-stat-label">${head.tag} Output Tokens</div></div>
        <div class="arm-stat"><div class="arm-stat-val">${head.turns}</div><div class="arm-stat-label">${head.tag} ${a ? "Messages" : "Turns"}</div></div>
      </div>
      ${has ? `<div class="arm-tokens">
        ${a ? `Core cache read: <span>${formatTokens(a.core.cacheReadTokens)}</span> &nbsp; Housekeeping: <span>${a.housekeeping.turns} msgs, ${formatCost(a.housekeeping.costUsd)}, ${formatDuration(a.housekeeping.durationMs)}</span> &nbsp;` : ""}
        Raw &mdash; Fresh Input: <span>${formatTokens(t.inputTokens)}</span> &nbsp;
        Output: <span>${formatTokens(t.outputTokens)}</span> &nbsp;
        Cache Read: <span>${formatTokens(t.cacheReadTokens)}</span> &nbsp;
        Cache Write: <span>${formatTokens(t.cacheCreationTokens)}</span>
      </div>` : `<div class="arm-tokens" style="color: var(--text-muted);">Token data unavailable</div>`}
      <div class="arm-tokens">
        ${hasTiming(arm) ? `${arm.attribution ? "" : `Model time (approx., duration minus tool wait): <span>${formatDuration(modelTimeMs(arm))}</span> &nbsp; `}Tool time: <span>${formatDuration(toolTimeMs(arm))}</span> &nbsp;` : ""}
        Diff: <span>${escapeHtml(formatDiffSummary(arm.diffStats))}</span>
      </div>
    </div>`;
  };

  const slowestRows = (arm: ArmResult) => slowestTools(arm.run.toolCalls, 5).map(tc => `
      <tr>
        <td>${formatDuration(tc.durationMs ?? 0)}</td>
        <td style="font-family: 'SF Mono', 'Fira Code', Consolas, monospace; font-size: 12px;">${escapeHtml(toolLabel(tc))}</td>
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
          <span class="bar-tag ${better ? "better" : "worse"}">Unblocked</span>
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
  const modelBreakdownRows = perModelRows("Baseline", b) + perModelRows("With Unblocked", u);

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
<title>Claude Harness — A/B Comparison</title>
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface-2: #1a1a26;
    --border: #2a2a3a;
    --text: #e4e4ed;
    --text-muted: #8888a0;
    --accent: #3b82f6;
    --accent-light: #93c5fd;
    --accent-glow: rgba(59, 130, 246, 0.15);
    --green: #22c55e;
    --green-bg: rgba(34, 197, 94, 0.1);
    --red: #ef4444;
    --yellow: #eab308;
    --blue: #3b82f6;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    min-height: 100vh;
  }

  .container { max-width: 1100px; margin: 0 auto; padding: 40px 24px; }

  .header {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 12px;
  }
  .logo {
    width: 44px; height: 44px;
    background: linear-gradient(135deg, var(--accent), var(--accent-light));
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 22px; color: white;
  }
  .header h1 {
    font-size: 28px;
    font-weight: 700;
    background: linear-gradient(135deg, var(--text), var(--accent-light));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .subtitle {
    color: var(--text-muted);
    font-size: 14px;
    margin-bottom: 40px;
  }
  .brand-tag {
    display: inline-block;
    background: var(--accent-glow);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 6px;
    padding: 2px 10px;
    font-size: 12px;
    color: var(--accent-light);
    font-weight: 600;
    letter-spacing: 0.5px;
  }

  .meta-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin-bottom: 40px;
  }
  .meta-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 18px;
    display: flex;
    justify-content: space-between;
  }
  .meta-key { color: var(--text-muted); font-size: 13px; }
  .meta-val { font-weight: 600; font-size: 13px; }

  .hero-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 20px;
    margin-bottom: 40px;
  }
  .hero-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 28px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .hero-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: linear-gradient(90deg, var(--accent), var(--accent-light));
  }
  .hero-card.positive::before {
    background: linear-gradient(90deg, var(--green), #4ade80);
  }
  .hero-card.negative::before {
    background: linear-gradient(90deg, var(--red), #f87171);
  }
  .hero-label {
    font-size: 13px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 8px;
  }
  .hero-value {
    font-size: 48px;
    font-weight: 800;
    line-height: 1.1;
    margin-bottom: 6px;
  }
  .hero-value.positive { color: var(--green); }
  .hero-value.negative { color: var(--red); }
  .hero-value.neutral { color: var(--accent-light); }
  .hero-card.neutral::before { background: linear-gradient(90deg, var(--accent), var(--accent-light)); }
  .hero-detail {
    font-size: 14px;
    color: var(--text-muted);
  }

  .section { margin-bottom: 40px; }
  .section-title {
    font-size: 18px;
    font-weight: 700;
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .section-title::before {
    content: '';
    width: 4px; height: 20px;
    background: var(--accent);
    border-radius: 2px;
  }

  .comparison-row {
    display: grid;
    grid-template-columns: 140px 1fr;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }
  .comp-label {
    font-size: 14px;
    color: var(--text-muted);
    text-align: right;
  }
  .comp-note { font-size: 11px; color: var(--text-muted); opacity: 0.7; line-height: 1.3; }
  .bar-group { display: flex; flex-direction: column; gap: 6px; }
  .bar-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .bar-tag {
    font-size: 11px;
    font-weight: 600;
    width: 70px;
    text-align: right;
    flex-shrink: 0;
  }
  .bar-tag.baseline { color: var(--text-muted); }
  .bar-tag.better { color: var(--green); }
  .bar-tag.worse { color: var(--red); }
  .bar-track {
    flex: 1;
    height: 28px;
    background: var(--surface-2);
    border-radius: 6px;
    overflow: hidden;
    position: relative;
  }
  .bar-fill {
    height: 100%;
    border-radius: 6px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    transition: width 0.6s ease;
  }
  .bar-fill.baseline { background: rgba(136, 136, 160, 0.25); color: var(--text-muted); }
  .bar-fill.better { background: rgba(34, 197, 94, 0.3); color: var(--green); }
  .bar-fill.worse { background: rgba(239, 68, 68, 0.3); color: var(--red); }

  .arm-section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
    margin-bottom: 20px;
  }
  .arm-header {
    padding: 16px 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border);
  }
  .arm-name {
    font-weight: 700;
    font-size: 15px;
  }
  .arm-meta {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;
    background: var(--border);
  }
  .arm-stat {
    background: var(--surface);
    padding: 16px;
    text-align: center;
  }
  .arm-stat-val {
    font-size: 22px;
    font-weight: 800;
    margin-bottom: 2px;
  }
  .arm-stat-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .arm-tokens {
    padding: 16px 20px;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 24px;
    font-size: 13px;
    color: var(--text-muted);
  }
  .arm-tokens span { color: var(--text); font-weight: 600; }

  .tool-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .tool-table th { text-align: left; padding: 10px 16px; font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
  .tool-table td { padding: 10px 16px; border-bottom: 1px solid rgba(42, 42, 58, 0.5); }
  .tool-table tr:last-child td { border-bottom: none; }
  .highlight-row td { background: rgba(59, 130, 246, 0.08); font-weight: 600; }
  .tool-table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; overflow: hidden; }

  .unblocked-grid { display: flex; flex-direction: column; gap: 8px; }
  .unblocked-card {
    background: var(--surface);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 10px;
    padding: 12px 16px;
    display: flex;
    gap: 12px;
    align-items: baseline;
  }
  .unblocked-tool {
    font-size: 13px; font-weight: 700;
    color: var(--accent-light);
    background: var(--accent-glow);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 4px;
    padding: 2px 8px;
    flex-shrink: 0;
  }
  .unblocked-query { font-size: 13px; color: var(--text-muted); }

  .diff-summary {
    display: flex;
    gap: 16px;
    font-size: 14px;
    color: var(--text-muted);
    margin-bottom: 12px;
  }
  .diff-added { color: var(--green); font-weight: 600; }
  .diff-removed { color: var(--red); font-weight: 600; }
  .diff-block {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: auto;
    max-height: 600px;
  }
  .diff-block pre {
    margin: 0;
    padding: 16px;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 12px;
    line-height: 1.5;
    tab-size: 4;
  }
  .diff-block code { white-space: pre; }
  .diff-file { color: var(--accent-light); font-weight: 700; }
  .diff-meta { color: var(--text-muted); }
  .diff-hunk { color: var(--blue); }
  .diff-add { color: var(--green); background: rgba(34, 197, 94, 0.08); display: inline-block; width: 100%; }
  .diff-del { color: var(--red); background: rgba(239, 68, 68, 0.08); display: inline-block; width: 100%; }

  .hero-3 { grid-template-columns: repeat(3, 1fr); }
  .section-note { font-size: 13px; color: var(--text-muted); margin: -8px 0 16px; line-height: 1.6; }
  .section-sub { font-size: 12px; font-weight: 500; color: var(--text-muted); margin-left: 8px; }
  .ledger { margin-top: 12px; }
  .ledger summary { cursor: pointer; font-size: 13px; color: var(--accent-light); padding: 6px 0; }
  .verdict { background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 12px; padding: 16px 20px; margin-bottom: 16px; font-size: 14px; line-height: 1.6; }
  .verdict.positive { border-left-color: var(--green); }
  .verdict.negative { border-left-color: var(--red); }
  .verdict-head { font-weight: 700; font-size: 16px; margin-bottom: 6px; }
  .verdict-conf { font-weight: 500; font-size: 13px; color: var(--text-muted); }
  .met { font-weight: 700; font-size: 13px; }
  .met-met { color: var(--green); } .met-partial { color: var(--yellow); } .met-unmet { color: var(--red); }
  .score { font-weight: 700; }
  .evidence { font-size: 12px; color: var(--text-muted); margin-top: 3px; line-height: 1.5; }
  .findings { display: flex; flex-direction: column; gap: 8px; }
  .finding { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; font-size: 13px; }
  .finding-arm { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-right: 8px; }
  .finding-arm.unblocked { color: var(--accent-light); } .finding-arm.baseline { color: var(--text-muted); }
  @media (max-width: 768px) { .hero-3 { grid-template-columns: 1fr; } }

  .footer {
    text-align: center;
    padding-top: 32px;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 13px;
  }
  .footer a { color: var(--accent-light); text-decoration: none; }

  @media (max-width: 768px) {
    .hero-grid { grid-template-columns: 1fr; }
    .comparison-row { grid-template-columns: 1fr; }
    .comp-label { text-align: left; }
    .meta-grid { grid-template-columns: 1fr; }
    .arm-meta { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <div class="logo">U</div>
    <h1>Claude Harness</h1>
  </div>
  <div class="subtitle">
    A/B Comparison &mdash; ${timestamp} &nbsp;
    <span class="brand-tag">Baseline vs Unblocked</span>
  </div>

  <div class="meta-grid">
    <div class="meta-item"><span class="meta-key">Repository</span><span class="meta-val">${escapeHtml(repoName(result.repo))}</span></div>
    <div class="meta-item"><span class="meta-key">Branch</span><span class="meta-val">${escapeHtml(result.branch)}</span></div>
    <div class="meta-item"><span class="meta-key">Model</span><span class="meta-val">${escapeHtml(result.model)}</span></div>
    <div class="meta-item"><span class="meta-key">Arms cost / analysis</span><span class="meta-val">${formatCost(result.totalEstimatedCost)}${result.analysisCostUsd ? ` / ${formatCost(result.analysisCostUsd)}` : ""}</span></div>
  </div>

  <div class="section">
    <div class="section-title">Task</div>
    <div style="background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px;">
      <div style="font-size: 14px; line-height: 1.7;">${escapeHtml(result.task)}</div>
    </div>
  </div>

  ${hasAttr ? `
  <div class="section">
    <div class="section-title">1 · Core task work</div>
    <div class="section-note">Reading, deciding, coding, testing. Housekeeping removed from both arms. Time is model time; tool wait is in section 2.</div>
    <div class="hero-grid hero-3">
      ${heroCard("Cost", b.attribution!.core.costUsd, u.attribution!.core.costUsd, formatCost)}
      ${hasCoreTiming ? heroCard("Model time", coreModelTimeMs(b), coreModelTimeMs(u), formatDuration) : ""}
      ${heroCard("Output tokens", b.attribution!.core.outputTokens, u.attribution!.core.outputTokens, formatTokens)}
    </div>
    ${barPair("Cost", b.attribution!.core.costUsd, u.attribution!.core.costUsd, maxCost, formatCost)}
    ${hasCoreTiming ? barPair("Model time", coreModelTimeMs(b), coreModelTimeMs(u), maxTime, formatDuration, "thinking + generation; the headline time") : ""}
    ${hasCoreTiming ? barPair("Tool wait", coreToolTimeMs(b), coreToolTimeMs(u), maxTime, formatDuration, "tests, CI, MCP, shell — depends on what each agent chose to run; see section 2") : ""}
    ${barPair("Output tokens", b.attribution!.core.outputTokens, u.attribution!.core.outputTokens, Math.max(b.attribution!.core.outputTokens, u.attribution!.core.outputTokens, 1), formatTokens, "what the model wrote")}
    ${barPair("Cache-read tokens", b.attribution!.core.cacheReadTokens, u.attribution!.core.cacheReadTokens, Math.max(b.attribution!.core.cacheReadTokens, u.attribution!.core.cacheReadTokens, 1), formatTokens, "context re-read per turn; 2% of output price")}
    ${barPair("Messages", b.attribution!.core.turns, u.attribution!.core.turns, Math.max(b.attribution!.core.turns, u.attribution!.core.turns, 1), String)}
    ${result.economics ? economicsBlock(result) : ""}
  </div>

  <div class="section">
    <div class="section-title">2 · Housekeeping and tool wait <span class="section-sub">excluded from the headline</span></div>
    <div class="section-note">Tool wait: time spent in tests, CI and shell commands, set by what each agent chose to run. Housekeeping: lockfile reverts, artifact cleanup, status checks, branching, committing, redundant reruns. Model habit, not context.</div>
    <div class="tool-table-wrap">
      <table class="tool-table">
        <thead><tr><th>Arm</th><th>Housekeeping msgs</th><th>Cost</th><th>Time</th><th>What it was</th><th>Tool wait in core work</th><th>Raw total</th></tr></thead>
        <tbody>
          <tr><td>Baseline</td><td>${b.attribution!.housekeeping.turns}</td><td>${formatCost(b.attribution!.housekeeping.costUsd)}</td><td>${formatDuration(b.attribution!.housekeeping.durationMs)}</td><td>${escapeHtml(housekeepingKinds(b)) || "–"}</td><td>${formatDuration(coreToolTimeMs(b))}</td><td>${formatCost(b.estimatedCost)} · ${formatDuration(b.run.durationMs)}</td></tr>
          <tr><td>With Unblocked</td><td>${u.attribution!.housekeeping.turns}</td><td>${formatCost(u.attribution!.housekeeping.costUsd)}</td><td>${formatDuration(u.attribution!.housekeeping.durationMs)}</td><td>${escapeHtml(housekeepingKinds(u)) || "–"}</td><td>${formatDuration(coreToolTimeMs(u))}</td><td>${formatCost(u.estimatedCost)} · ${formatDuration(u.run.durationMs)}</td></tr>
        </tbody>
      </table>
    </div>
    ${stallNote(b, u)}
    <details class="ledger"><summary>Excluded turns, with reasons</summary>
      ${housekeepingLedger("Baseline", b)}
      ${housekeepingLedger("With Unblocked", u)}
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
    ${[["Baseline", b], ["With Unblocked", u]].map(([label, arm]) => {
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
            <tr><td style="width: 90px;"><span class="met ${c.severity === "must-fix" ? "met-unmet" : c.severity === "should-fix" ? "met-partial" : ""}">${c.severity}</span></td><td style="font-family: 'SF Mono', 'Fira Code', Consolas, monospace; font-size: 12px; width: 220px;">${escapeHtml(c.file.split("/").slice(-2).join("/"))}</td><td style="font-size: 13px;">${escapeHtml(c.comment)}</td></tr>`).join("")}</tbody></table>` : ""}
        </div>`).join("")}
      </div>`;
    }).join("")}
  </div>` : ""}

  ${result.quality ? `
  <div class="section">
    <div class="section-title">3 · Quality analysis <span class="section-sub">blinded judge: ${escapeHtml(result.quality.judgeModel)}</span></div>
    <div class="section-note">Blinded judge: saw task, final responses, tests run, diffs and the checker's final record as A/B in random order. Grades the same requirement list as the checker. Its verdict is decided by requirements met, then by defects the change introduces within that scope, then by material hygiene; other work beyond the task does not count. A blinded tie goes to Unblocked only when the Unblocked agent's candidate discovery materially improved the outcome or invalidated a requirement, and the un-blinded impact pass finds the research context led to it. Discoveries the agent made on its own, on either side, measure model variance and never break a tie.</div>
    <div class="verdict ${result.quality.verdict.better === "unblocked" ? "positive" : result.quality.verdict.better === "baseline" ? "negative" : ""}">
      <div class="verdict-head">Verdict: ${result.quality.verdict.better === "tie" ? "tie" : result.quality.verdict.better === "unblocked" ? "With Unblocked" : "Baseline"}${result.quality.verdict.tieBreaker?.applied ? ` <span class="verdict-conf">· blinded verdict was a tie; decided by the context-led discovery tie-breaker</span>` : result.impact ? ` <span class="verdict-conf">· driver: ${result.impact.impact.outcomeDriver === "context" ? "the Unblocked context" : result.impact.impact.outcomeDriver === "agent" ? "agent behaviour, not context" : "context and agent behaviour"}</span>` : ""}</div>
      <div>${escapeHtml(result.quality.verdict.rationale)}</div>
      ${result.quality.verdict.tieBreaker ? `<div class="evidence" style="margin-top: 6px;">Tie-breaker: ${result.quality.verdict.tieBreaker.applied ? "applied" : "not applied"} · ${escapeHtml(result.quality.verdict.tieBreaker.reason)}</div>` : ""}
    </div>
    ${result.quality.discoveries ? `<div class="findings" style="margin-bottom: 16px;">${(["baseline", "unblocked"] as const).map(a => {
      const d = result.quality!.discoveries![a];
      const label = a === "baseline" ? "Baseline" : "With Unblocked";
      if (d.kind === "none") return `<div class="finding"><b>${label}</b> · candidate discovery: none</div>`;
      const attr = a === "unblocked" ? result.impact?.discoveryAttribution : undefined;
      const tag = a === "baseline" ? `<span class="met met-partial">agent-found; baseline has no context, so it cannot break a tie</span>`
        : attr ? (attr.contextLed ? `<span class="met met-met">led by the context</span>` : `<span class="met met-partial">not led by the context</span>`) : "";
      return `<div class="finding"><b>${label}</b> · candidate discovery: ${d.kind === "improved-outcome" ? "improved the outcome" : `invalidated requirement ${(d.requirementIndex ?? 0) + 1} for both agents`} ${tag}<div style="margin-top: 4px;">${escapeHtml(d.fact)} &rarr; ${escapeHtml(d.effect)}</div><div class="evidence">${escapeHtml(d.evidence)}${attr && a === "unblocked" ? ` · attribution: ${escapeHtml(attr.evidence)}` : ""}</div></div>`;
    }).join("")}</div>` : ""}
    <div class="tool-table-wrap" style="margin-bottom: 16px;">
      <table class="tool-table">
        <thead><tr><th>Requirement from the task</th><th>Baseline</th><th>With Unblocked</th></tr></thead>
        <tbody>${result.quality.requirements.map(rq => `
          <tr>
            <td>${escapeHtml(rq.requirement)}</td>
            <td><span class="met met-${rq.baseline.status}">${MET_ICON[rq.baseline.status]} ${rq.baseline.status}</span><div class="evidence">${escapeHtml(rq.baseline.evidence)}</div></td>
            <td><span class="met met-${rq.unblocked.status}">${MET_ICON[rq.unblocked.status]} ${rq.unblocked.status}</span><div class="evidence">${escapeHtml(rq.unblocked.evidence)}</div></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <div class="tool-table-wrap" style="margin-bottom: 16px;">
      <table class="tool-table">
        <thead><tr><th>Criterion</th><th>Baseline</th><th>With Unblocked</th></tr></thead>
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
      <div class="finding"><span class="finding-arm ${f.arm}">${f.arm === "unblocked" ? "With Unblocked" : "Baseline"}</span> ${escapeHtml(f.finding)}<div class="evidence">${escapeHtml(f.evidence)}</div></div>`).join("")}</div>` : ""}
  </div>` : ""}

  ${result.impact ? `
  <div class="section">
    <div class="section-title">4 · What the Unblocked context did <span class="section-sub">un-blinded: ${escapeHtml(result.impact.model)}</span></div>
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
    ${armCard("With Unblocked", u, true)}
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
        <thead><tr><th>Tool</th><th>Baseline</th><th>Unblocked</th><th>Delta</th>${hasToolTiming ? `<th>Baseline time</th><th>Unblocked time</th>` : ""}</tr></thead>
        <tbody>${toolCompareRows}</tbody>
      </table>
    </div>
    ${[["Baseline", b], ["Unblocked", u]].filter(([, a]) => shellOnlyEdits(a as ArmResult)).map(([n, a]) => `
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
          <thead><tr><th colspan="2">With Unblocked</th></tr></thead>
          <tbody>${slowestRows(u)}</tbody>
        </table>
      </div>
    </div>
  </div>` : ""}

  ${u.unblockedCalls.length > 0 ? `
  <div class="section">
    <div class="section-title">Unblocked Context Queries</div>
    <div class="unblocked-grid">
      ${u.unblockedCalls.map(c => `
        <div class="unblocked-card">
          <span class="unblocked-tool">${escapeHtml(c.tool)}</span>
          ${c.query ? `<span class="unblocked-query">${escapeHtml(c.query.slice(0, 200))}</span>` : ""}
        </div>
      `).join("")}
    </div>
  </div>` : ""}

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
    <div class="section-title">Code Changes &mdash; With Unblocked</div>
    <div class="diff-summary">
      <span>${u.diffStats.filesChanged} files</span>
      <span class="diff-added">+${u.diffStats.linesAdded}</span>
      <span class="diff-removed">-${u.diffStats.linesRemoved}</span>
      ${u.diffStats.commits ? `<span>${u.diffStats.commits} commit${u.diffStats.commits === 1 ? "" : "s"} by agent (included)</span>` : ""}
      ${u.diffStats.truncated ? `<span>diff text truncated</span>` : ""}
    </div>
    <div class="diff-block"><pre><code>${formatDiff(u.diff)}</code></pre></div>
  </div>

  <div class="footer">
    Generated by Claude Harness &mdash;
    <a href="https://getunblocked.com">Unblocked</a>
  </div>

</div>
</body>
</html>`;

  const htmlPath = path.join(outDir, "report.html");
  fs.writeFileSync(htmlPath, html);
  return htmlPath;
}

export function writeBatchSummary(config: { task: string; repo: string; branch: string; model: string; repeat: number }, results: ComparisonResult[], batchDir: string): string {
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
    return `<tr><td><a href="run-${i + 1}/report.html">run ${i + 1}</a></td><td>${v ? (v.better === "unblocked" ? "With Unblocked" : v.better === "baseline" ? "Baseline" : "tie") : "–"}${v?.tieBreaker?.applied ? " <span class=\"met met-met\">tie-breaker</span>" : ""}</td><td>${r.impact ? escapeHtml(r.impact.impact.outcomeDriver) : "–"}</td><td>${formatCost(b.costUsd)} → ${formatCost(u.costUsd)} (${pct(b.costUsd, u.costUsd)})</td><td>${formatDuration(b.durationMs)} → ${formatDuration(u.durationMs)} (${pct(b.durationMs, u.durationMs)})</td><td>${b.turns} → ${u.turns}</td><td style="font-size: 12px;">${escapeHtml(v?.rationale ?? "")}</td></tr>`;
  });
  const bC = med("baseline", c => c.costUsd), uC = med("unblocked", c => c.costUsd), bT = med("baseline", c => c.durationMs), uT = med("unblocked", c => c.durationMs);
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Claude Harness — Batch Summary</title>
<style>
  :root { --bg: #0a0a0f; --surface: #12121a; --border: #2a2a3a; --text: #e4e4ed; --text-muted: #8888a0; --accent: #3b82f6; --green: #22c55e; --red: #ef4444; --yellow: #eab308; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; padding: 32px 16px; }
  .container { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 4px; } .sub { color: var(--text-muted); margin-bottom: 24px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
  .card .k { color: var(--text-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 1px; } .card .v { font-size: 26px; font-weight: 700; } .card .d { color: var(--text-muted); font-size: 13px; }
  .pos { color: var(--green); } .neg { color: var(--red); }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: top; } th { color: var(--text-muted); font-weight: 600; }
  a { color: #93c5fd; } .met { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; } .met-met { background: rgba(34,197,94,0.15); color: var(--green); }
  .note { color: var(--text-muted); font-size: 13px; margin-top: 16px; }
</style></head><body><div class="container">
  <h1>Batch summary · ${results.length} of ${config.repeat} repeat(s)</h1>
  <div class="sub">${escapeHtml(repoName(config.repo))} @ ${escapeHtml(config.branch)} · ${escapeHtml(config.model)} · ${escapeHtml(config.task.slice(0, 160))}${config.task.length > 160 ? "…" : ""}</div>
  <div class="grid">
    <div class="card"><div class="k">Verdicts</div><div class="v">${counts.unblocked}–${counts.tie}–${counts.baseline}</div><div class="d">Unblocked – tie – baseline${counts.none ? ` · ${counts.none} without a verdict` : ""}</div></div>
    <div class="card"><div class="k">Median core cost</div><div class="v ${uC <= bC ? "pos" : "neg"}">${pct(bC, uC)}</div><div class="d">${formatCost(bC)} → ${formatCost(uC)}</div></div>
    <div class="card"><div class="k">Median core time</div><div class="v ${uT <= bT ? "pos" : "neg"}">${pct(bT, uT)}</div><div class="d">${formatDuration(bT)} → ${formatDuration(uT)}</div></div>
  </div>
  <table><thead><tr><th>Run</th><th>Verdict</th><th>Driver</th><th>Core cost (B → U)</th><th>Core time (B → U)</th><th>Messages</th><th>Rationale</th></tr></thead><tbody>${rows.join("")}</tbody></table>
  <div class="note">Each run is an independent comparison (fresh worktrees, its own requirement check, judge and impact pass). Medians are over core work with housekeeping removed, across the ${judged.length} of ${results.length} run(s) that reached a verdict${judged.length < results.length ? " (a killed or timed-out run's partial spend is not comparable and is excluded)" : ""}. Verdicts follow the same rubric as the per-run reports.</div>
</div></body></html>`;
  const out = path.join(batchDir, "summary.html");
  fs.writeFileSync(out, html);
  fs.writeFileSync(path.join(batchDir, "summary.json"), JSON.stringify({ config, verdicts: counts, medians: { baseline: { costUsd: bC, durationMs: bT }, unblocked: { costUsd: uC, durationMs: uT } }, runs: results.map((r, i) => ({ dir: `run-${i + 1}`, verdict: r.quality?.verdict, driver: r.impact?.impact.outcomeDriver, baseline: core(r, "baseline"), unblocked: core(r, "unblocked") })) }, null, 2));
  return out;
}
