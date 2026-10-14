// Cross-run consolidation: what the context did, read from every run of the
// same ticket together.
//
// Each run's impact pass sees one pair of transcripts and labels a few
// episodes; most of the measured difference falls outside them, so a single
// run cannot say how much of it the context caused. Repeats can: the context
// is the only systematic difference between the arms, so a difference that
// points the same way in every comparable run is the context's doing, unless
// a consistent cause other than the context explains it. Variance shows up as
// differences that change direction from run to run.
//
// One judge call decides which runs are comparable (both arms delivered the
// same scope) and names consistent patterns with their episodes; the harness
// does the arithmetic.
import type { ComparisonResult, Condition, ToolCall } from "./types.ts";
import type { ContextEffect, EpisodeSum, Totals } from "./context-effect.ts";
import { runStructured } from "./analyst.ts";
import { unblockedCommand } from "./unblocked-cli.ts";
import { formatCost, log } from "./util.ts";

export const CONSOLIDATE_MODEL = "claude-opus-5-5";

// What each arm spent its tool calls on, by kind.
const KINDS: [string, (tc: ToolCall, cmd: string) => boolean][] = [
  ["research", (tc, cmd) => tc.name.startsWith("mcp__unblocked__") || !!unblockedCommand(cmd)],
  ["visual checks (storybook, playwright, screenshots)", (_, cmd) => /storybook|playwright|screenshot/i.test(cmd)],
  ["tests", (_, cmd) => /\b(jest|vitest|go test|pytest|rspec)\b|gradlew\b[^\n]*\btest\b|\btest\b[^\n]*--tests/i.test(cmd)],
  ["lint and typecheck", (_, cmd) => /\b(lint\w*|ktlint|detekt|eslint|tsc|go vet|typecheck)\b/i.test(cmd)],
  ["builds", (_, cmd) => /gradlew\b[^\n]*\b(build|compile\w*|assemble)\b|\bmake\b|go build/i.test(cmd)],
  ["git history", (_, cmd) => /\bgit\s+(log|show|blame)\b/.test(cmd)],
  ["code search", (tc, cmd) => tc.name === "Grep" || tc.name === "Glob" || /\b(rg|grep|find)\b/.test(cmd)],
  ["file reads", (tc, cmd) => tc.name === "Read" || /^\s*(cat|sed -n|head|tail)\b/.test(cmd)],
  ["edits", tc => /^(Edit|Write|MultiEdit)$/.test(tc.name)],
];

export function activityProfile(toolCalls: ToolCall[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const tc of toolCalls) {
    if (tc.nested) continue;
    const cmd = String(tc.args.command ?? "");
    const kind = KINDS.find(([, test]) => test(tc, cmd));
    if (kind) out[kind[0]] = (out[kind[0]] ?? 0) + 1;
  }
  return out;
}

export type PatternCause = "context" | "agent" | "environment" | "fix loop";
export interface Pattern {
  description: string;
  cause: PatternCause;
  direction: "baseline-more" | "unblocked-more";
  runs: number[];
  consistent: boolean;
  evidence: string;
  episodes: { run: number; episode: number }[];
}
export interface RunRead { run: number; comparable: boolean; reason: string }

// One metric, consolidated.
export interface MetricRead {
  key: keyof Totals;
  comparableRuns: number[];
  measured: number[];        // per comparable run, % vs Baseline
  consistent: boolean;       // same direction across the comparable runs
  carvedOut: number[];       // per comparable run, % explained by consistent non-context patterns
  influence: number | null;  // median(measured - carvedOut) when consistent
  range: [number, number] | null;
  byContextPatterns: number; // median % the context patterns' episodes account for
  perRunLabels: number;      // median of each run's own context's-influence figure
}

export interface Consolidation {
  task: string;
  dirs: string[];
  verdicts: string[];
  runs: RunRead[];
  patterns: Pattern[];
  metrics: MetricRead[];
  summary: string;
  model: string;
  costUsd: number;
}

const SCHEMA = {
  type: "object",
  properties: {
    runs: { type: "array", items: { type: "object", properties: {
      run: { type: "integer" }, comparable: { type: "boolean" }, reason: { type: "string" },
    }, required: ["run", "comparable", "reason"] } },
    patterns: { type: "array", items: { type: "object", properties: {
      description: { type: "string" },
      cause: { type: "string", enum: ["context", "agent", "environment", "fix loop"] },
      direction: { type: "string", enum: ["baseline-more", "unblocked-more"] },
      runs: { type: "array", items: { type: "integer" } },
      consistent: { type: "boolean" },
      evidence: { type: "string" },
      episodes: { type: "array", items: { type: "object", properties: { run: { type: "integer" }, episode: { type: "integer" } }, required: ["run", "episode"] } },
    }, required: ["description", "cause", "direction", "runs", "consistent", "evidence", "episodes"] } },
    summary: { type: "string" },
  },
  required: ["runs", "patterns", "summary"],
};

const pct = (from: number, to: number) => (from ? Math.round(((to - from) / from) * 100) : 0);

export function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2);
}

// Same direction in every comparable run; with four or more, three in four.
export function isConsistent(values: number[]): boolean {
  const moved = values.filter(v => v !== 0);
  if (moved.length < 2) return false;
  const down = moved.filter(v => v < 0).length, up = moved.length - down;
  const agree = Math.max(down, up) / moved.length;
  return moved.length >= 4 ? agree >= 0.75 : agree === 1;
}

function runBlock(r: ComparisonResult, i: number): string {
  const e = r.contextEffect!;
  const prof = (c: Condition) => Object.entries(activityProfile(r[c].run.toolCalls)).map(([k, n]) => `${k} ${n}`).join(", ");
  const im = r.impact;
  const req = (r.quality?.requirements ?? []).map(q => `${q.requirement.slice(0, 70)}: Baseline ${q.baseline.status}, Unblocked ${q.unblocked.status}`).join("; ");
  return `=================== RUN ${i + 1} ===================
Verdict (blinded judge): ${r.quality?.verdict.better ?? "none"}. ${r.quality?.verdict.rationale ?? ""}
Requirements: ${req || "-"}
Fix loop: ${r.baseline.review ? `on (Baseline ${r.baseline.review.passes.length} round(s), Unblocked ${r.unblocked.review?.passes.length ?? 0})` : "off (single pass)"}
Core totals: Baseline $${e.baseline.costUsd.toFixed(2)}, ${Math.round(e.baseline.durationMs / 1000)}s, ${Math.round(e.baseline.tokens / 1000)}k tokens, diff ${r.baseline.diffStats.filesChanged} files +${r.baseline.diffStats.linesAdded}; Unblocked $${e.unblocked.costUsd.toFixed(2)}, ${Math.round(e.unblocked.durationMs / 1000)}s, ${Math.round(e.unblocked.tokens / 1000)}k tokens, diff ${r.unblocked.diffStats.filesChanged} files +${r.unblocked.diffStats.linesAdded}. Cost difference ${pct(e.baseline.costUsd, e.unblocked.costUsd)}%.
Tool calls by kind: Baseline: ${prof("baseline")}. Unblocked: ${prof("unblocked")}.
What the Unblocked arm's research returned and how it was used:
${(im?.research ?? []).map(x => `- T${x.turn} [${x.value}] ${x.query.slice(0, 160)}; used: ${x.itemsUsed.map(u => `${u.item.slice(0, 80)} (${u.use.slice(0, 100)})`).join("; ") || "nothing"}; note: ${x.note.slice(0, 200)}`).join("\n") || "- none"}
Impact summary: ${im?.impact.summary ?? "-"}
Episodes (index: arm, turns, analyst's cause, cost, what):
${e.episodes.map((x, j) => `  ${j}: ${x.arm}, T${x.fromTurn}-T${x.toTurn}, ${x.cause}, $${x.costUsd.toFixed(2)}, ${x.what}`).join("\n") || "  none"}`;
}

function prompt(task: string, results: ComparisonResult[]): string {
  return `The same coding task was run ${results.length} times. Each run compares a Baseline agent with an agent that also had Unblocked, a context engine that returns the organisation's PRs, docs, chat and issues. Everything else about the arms is identical, so the context is the only systematic difference between them. A difference that points the same way in run after run is therefore the context's doing, unless a consistent cause other than the context explains it; a difference that changes direction between runs is ordinary variance.

Your job, across the runs:
1. runs: for every run, decide whether its cost, time and token figures are comparable: both arms delivered the same scope of work. A run where one arm delivered a fraction of the task (e.g. only a settings slice) is not comparable; differences in quality details within the same scope are fine. Give a one-sentence reason.
2. patterns: name the behaviours that differ between the arms across runs, using the tool-call counts, totals and episodes. For each: direction, the 1-based runs where it appears, whether it is consistent (same direction in at least half the runs and never the opposite), and its cause:
   - "context": the research shaped it (cite what the research returned that plausibly causes it, or what the Baseline had to do for lack of it). Indirect effects count: an agent handed a working pattern may verify or explore less.
   - "agent": a choice unrelated to anything the research returned, that would plausibly happen in either arm.
   - "environment": machine or tooling noise.
   - "fix loop": extra rounds the requirement checker sent one arm back for, when unrelated to the context.
   List the episodes (run, episode index) that make up the pattern, from either arm. Only list episodes that clearly belong to it.
3. summary: at most 120 words, plain language: what the context consistently did across the runs, for better or worse, what was variance, and which runs were left out of the numbers and why.

Be strict about "agent" and "environment": label a consistent pattern so only with a concrete reason it is not the context, since anything consistent is otherwise the context's doing.

=================== TASK ===================
${task.slice(0, 4000)}

${results.map((r, i) => runBlock(r, i)).join("\n\n")}`;
}

function share(eps: EpisodeSum[], key: keyof Totals, base: number): number {
  const sum = (arm: Condition) => eps.filter(x => x.arm === arm).reduce((s, x) => s + x[key], 0);
  return base ? ((sum("unblocked") - sum("baseline")) / base) * 100 : 0;
}

export function readMetrics(effects: ContextEffect[], runs: RunRead[], patterns: Pattern[]): MetricRead[] {
  const comparable = runs.filter(r => r.comparable).map(r => r.run).filter(n => n >= 1 && n <= effects.length);
  const episodesOf = (p: Pattern, run: number) => p.episodes.filter(x => x.run === run).map(x => effects[run - 1].episodes[x.episode]).filter(Boolean);
  const carveOutPatterns = patterns.filter(p => p.consistent && p.cause !== "context");
  const contextPatterns = patterns.filter(p => p.consistent && p.cause === "context");
  return (["costUsd", "durationMs", "tokens"] as (keyof Totals)[]).map(key => {
    const measured = comparable.map(n => pct(effects[n - 1].baseline[key], effects[n - 1].unblocked[key]));
    const carvedOut = comparable.map(n => Math.round(carveOutPatterns.reduce((s, p) => s + share(episodesOf(p, n), key, effects[n - 1].baseline[key]), 0)));
    const net = measured.map((m, i) => m - carvedOut[i]);
    const consistent = isConsistent(net);
    return {
      key,
      comparableRuns: comparable,
      measured,
      consistent,
      carvedOut,
      influence: consistent ? median(net) : null,
      range: net.length ? [Math.min(...net), Math.max(...net)] : null,
      byContextPatterns: comparable.length ? median(comparable.map(n => Math.round(contextPatterns.reduce((s, p) => s + share(episodesOf(p, n), key, effects[n - 1].baseline[key]), 0)))) : 0,
      perRunLabels: median(effects.map(e => pct(e.adjustedBaseline[key], e.adjustedUnblocked[key]))),
    };
  });
}

export async function consolidate(results: { dir: string; result: ComparisonResult }[], model = CONSOLIDATE_MODEL): Promise<Consolidation | null> {
  const usable = results.filter(x => x.result.contextEffect);
  if (usable.length < 2) { log("Consolidate: need at least two runs with a context effect"); return null; }
  const task = usable[0].result.task;
  log(`Consolidate: ${usable.length} runs, with ${model}…`);
  const res = await runStructured<{ runs: RunRead[]; patterns: Pattern[]; summary: string }>(
    "Consolidate", prompt(task, usable.map(x => x.result)), model, SCHEMA, 15 * 60 * 1000, false);
  if (!res) return null;
  // Every run gets a comparability call; one the judge skipped counts as comparable.
  const runs: RunRead[] = usable.map((_, i) => res.data.runs.find(r => r.run === i + 1) ?? { run: i + 1, comparable: true, reason: "not assessed" });
  const half = Math.ceil(usable.length / 2);
  const patterns = res.data.patterns.map(p => ({ ...p, consistent: p.consistent && p.runs.length >= half }));
  const metrics = readMetrics(usable.map(x => x.result.contextEffect!), runs, patterns);
  log(`Consolidate: ${runs.filter(r => r.comparable).length}/${usable.length} comparable runs, ${patterns.filter(p => p.consistent).length} consistent pattern(s); ${formatCost(res.costUsd)} via ${res.modelUsed}`);
  return {
    task, dirs: usable.map(x => x.dir), verdicts: usable.map(x => x.result.quality?.verdict.better ?? "none"),
    runs, patterns, metrics, summary: res.data.summary.trim(), model: res.modelUsed, costUsd: res.costUsd,
  };
}
