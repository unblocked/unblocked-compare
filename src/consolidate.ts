// Cross-run consolidation: one judge pass over every run of the same ticket.
//
// A single run's impact pass labels each episode by what it can see in that
// one pair of transcripts, so a behaviour the context changes indirectly (an
// agent that, given a working pattern, skips visual checks) reads as "the
// agent's own choice". Repeats are the evidence: a difference that shows up
// in the same direction run after run is not variance. This pass looks
// across the runs for such patterns and may relabel episodes, under rules the
// harness enforces; the numbers are then recomputed per run, deterministically.
import type { ComparisonResult, Condition, EpisodeCause, ToolCall } from "./types.ts";
import { computeContextEffect, type ContextEffect, type Totals } from "./context-effect.ts";
import { runStructured } from "./analyst.ts";
import { unblockedCommand } from "./unblocked-cli.ts";
import { formatCost, log } from "./util.ts";

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

export interface Pattern { description: string; direction: "baseline-more" | "unblocked-more"; runs: number[]; consistent: boolean; cause: "context" | "agent"; evidence: string }
export interface Reclassification { run: number; episode: number; from: EpisodeCause; to: EpisodeCause; pattern: number; reason: string }
export interface RunEffect { dir: string; verdict: string; before: ContextEffect; after: ContextEffect }
export interface Consolidation {
  task: string;
  runs: RunEffect[];
  patterns: Pattern[];
  reclassifications: Reclassification[];
  rejected: { run: number; episode: number; reason: string }[];
  summary: string;
  model: string;
  costUsd: number;
}

const SCHEMA = {
  type: "object",
  properties: {
    patterns: { type: "array", items: { type: "object", properties: {
      description: { type: "string" },
      direction: { type: "string", enum: ["baseline-more", "unblocked-more"] },
      runs: { type: "array", items: { type: "integer" } },
      consistent: { type: "boolean" },
      cause: { type: "string", enum: ["context", "agent"] },
      evidence: { type: "string" },
    }, required: ["description", "direction", "runs", "consistent", "cause", "evidence"] } },
    reclassify: { type: "array", items: { type: "object", properties: {
      run: { type: "integer" },
      episode: { type: "integer" },
      cause: { type: "string", enum: ["context", "agent", "environment"] },
      pattern: { type: "integer" },
      reason: { type: "string" },
    }, required: ["run", "episode", "cause", "pattern", "reason"] } },
    summary: { type: "string" },
  },
  required: ["patterns", "reclassify", "summary"],
};

const pct = (from: number, to: number) => (from ? Math.round(((to - from) / from) * 100) : 0);

function runBlock(r: ComparisonResult, i: number): string {
  const e = r.contextEffect;
  const prof = (c: Condition) => Object.entries(activityProfile(r[c].run.toolCalls)).map(([k, n]) => `${k} ${n}`).join(", ");
  const im = r.impact;
  return `=================== RUN ${i + 1} ===================
Verdict (blinded judge): ${r.quality?.verdict.better ?? "none"}. ${r.quality?.verdict.rationale ?? ""}
Fix loop: ${r.baseline.review ? `on (Baseline ${r.baseline.review.passes.length} round(s), Unblocked ${r.unblocked.review?.passes.length ?? 0})` : "off (single pass)"}
Core totals: Baseline $${e?.baseline.costUsd.toFixed(2)}, ${Math.round((e?.baseline.durationMs ?? 0) / 1000)}s; Unblocked $${e?.unblocked.costUsd.toFixed(2)}, ${Math.round((e?.unblocked.durationMs ?? 0) / 1000)}s
Tool calls by kind: Baseline: ${prof("baseline")}. Unblocked: ${prof("unblocked")}.
What the Unblocked arm's research returned and how it was used:
${(im?.research ?? []).map(x => `- T${x.turn} [${x.value}] ${x.query.slice(0, 160)}; used: ${x.itemsUsed.map(u => `${u.item.slice(0, 80)} (${u.use.slice(0, 100)})`).join("; ") || "nothing"}; note: ${x.note.slice(0, 200)}`).join("\n") || "- none"}
Impact summary: ${im?.impact.summary ?? "-"}
Episodes (index: arm, turns, cause, cost, what):
${(e?.episodes ?? []).map((x, j) => `  ${j}: ${x.arm}, T${x.fromTurn}-T${x.toTurn}, ${x.cause}, $${x.costUsd.toFixed(2)}, ${x.what}`).join("\n") || "  none"}`;
}

function prompt(task: string, results: ComparisonResult[]): string {
  return `The same coding task was run ${results.length} times. Each run compares a Baseline agent with an agent that also had Unblocked, a context engine that returns the organisation's PRs, docs, chat and issues. For each run, an analyst labelled the episodes that made the arms differ: "context" (shaped by Unblocked's context in the Unblocked arm, or work the Baseline did for lack of it), "agent" (a choice the model made on its own), or "environment". Each run was labelled on its own, so a behaviour the context changes indirectly can be mislabelled "agent" in every run.

Your job: look ACROSS the runs for behaviours that differ between the arms in a consistent direction, decide whether each pattern is the context's doing or ordinary variance, and correct episode labels accordingly.

Rules:
- A pattern is "consistent" only when it appears in at least half of the runs in the same direction (one arm does it more), and in no run in the opposite direction. Use the tool-call counts and episodes as evidence; list the 1-based run numbers where it appears.
- cause "context" requires a plausible mechanism tied to what the Unblocked arm's research returned in those runs (cite the item: e.g. it returned a working pattern to copy, so the agent did not need to verify the UI by eye). Without such a link, cause is "agent".
- Reclassify an episode to "context" only when it belongs to a consistent pattern with cause "context". Reclassify a "context" episode to "agent" only when a consistent pattern shows the same work in both arms at a similar rate. Leave everything else alone; most episodes should stay as they are.
- Some runs had a fix loop (a checker sent the agent back to meet open requirements) and some were a single pass; extra fix rounds explain extra work, not the context.
- run is 1-based; episode is the episode index shown for that run; pattern is the 0-based index into your patterns list.
- summary: at most 120 words, plain language, what the runs show together about the context's influence, including what stays variance.

=================== TASK ===================
${task.slice(0, 4000)}

${results.map((r, i) => runBlock(r, i)).join("\n\n")}`;
}

function withCauses(r: ComparisonResult, causes: EpisodeCause[]): ComparisonResult {
  if (!r.impact?.episodes) return r;
  return { ...r, impact: { ...r.impact, episodes: r.impact.episodes.map((ep, j) => ({ ...ep, cause: causes[j] ?? ep.cause })) } };
}

export async function consolidate(results: { dir: string; result: ComparisonResult }[], model: string): Promise<Consolidation | null> {
  const usable = results.filter(x => x.result.contextEffect && x.result.impact?.episodes);
  if (usable.length < 2) { log("Consolidate: need at least two runs with episodes"); return null; }
  const task = usable[0].result.task;
  log(`Consolidate: ${usable.length} runs, with ${model}…`);
  const res = await runStructured<{ patterns: Pattern[]; reclassify: { run: number; episode: number; cause: EpisodeCause; pattern: number; reason: string }[]; summary: string }>(
    "Consolidate", prompt(task, usable.map(x => x.result)), model, SCHEMA, 15 * 60 * 1000, false);
  if (!res) return null;
  const { patterns, summary } = res.data;

  // Enforce the rules: a relabel must point at a consistent pattern that
  // covers its run, and a move to "context" needs a pattern with cause context.
  const half = Math.ceil(usable.length / 2);
  const causes = usable.map(x => x.result.impact!.episodes!.map(ep => ep.cause));
  const reclassifications: Reclassification[] = [], rejected: Consolidation["rejected"] = [];
  for (const rc of res.data.reclassify) {
    const p = patterns[rc.pattern], runIdx = rc.run - 1;
    const from = causes[runIdx]?.[rc.episode];
    const why =
      from === undefined ? "no such run or episode"
      : !p ? "no such pattern"
      : !p.consistent || p.runs.length < half ? `pattern is not consistent (seen in ${p.runs.length} of ${usable.length} runs)`
      : !p.runs.includes(rc.run) ? "pattern does not cover this run"
      : rc.cause === "context" && p.cause !== "context" ? "pattern is not attributed to the context"
      : from === rc.cause ? "already labelled so"
      : "";
    if (why) { rejected.push({ run: rc.run, episode: rc.episode, reason: why }); continue; }
    causes[runIdx][rc.episode] = rc.cause;
    reclassifications.push({ run: rc.run, episode: rc.episode, from: from!, to: rc.cause, pattern: rc.pattern, reason: rc.reason });
  }

  const runs = usable.map((x, i) => ({
    dir: x.dir,
    verdict: x.result.quality?.verdict.better ?? "none",
    before: x.result.contextEffect!,
    after: computeContextEffect(withCauses(x.result, causes[i])) ?? x.result.contextEffect!,
  }));
  log(`Consolidate: ${patterns.length} pattern(s), ${reclassifications.length} relabel(s), ${rejected.length} rejected; ${formatCost(res.costUsd)} via ${res.modelUsed}`);
  return { task, runs, patterns, reclassifications, rejected, summary: summary.trim(), model: res.modelUsed, costUsd: res.costUsd };
}

// The context's influence for one run and metric, in percent of the Baseline.
export function influencePct(e: ContextEffect, key: keyof Totals): number {
  return pct(e.adjustedBaseline[key], e.adjustedUnblocked[key]);
}
export function measuredPct(e: ContextEffect, key: keyof Totals): number {
  return pct(e.baseline[key], e.unblocked[key]);
}
export function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2);
}
