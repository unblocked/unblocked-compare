// What the context did to cost, time and tokens, with confounders removed.
//
// The impact pass names the episodes that make the arms differ and whether
// each came from the context or is a confounder (agent behaviour unrelated to
// the context, or the environment). Here the harness sums each episode from
// the attribution's per-message figures, so the model classifies and the
// numbers stay deterministic.
//
// The context effect is a counterfactual: the Baseline's totals plus only the
// context-driven differences (what the context arm spent on and because of
// the context, minus what the Baseline spent for lack of it). Confounders drop
// out without deciding which of an arm's own runs to keep: subtracting one
// arm's failed runs would also subtract work, like a cold build, that the
// other arm's figures still carry. A short TL;DR is written from the numbers.
import type { ArmResult, ComparisonResult, Condition, EpisodeCause } from "./types.ts";
import { formatCost, formatTokens, log } from "./util.ts";
import { runStructured } from "./analyst.ts";

export interface Totals { costUsd: number; durationMs: number; tokens: number }
export interface EpisodeSum extends Totals { arm: Condition; fromTurn: number; toTurn: number; cause: EpisodeCause; what: string }
export interface ContextEffect {
  baseline: Totals;
  unblocked: Totals;
  // Confounders removed: the Baseline as is, and the Baseline plus the
  // context-driven differences.
  adjustedBaseline: Totals;
  adjustedUnblocked: Totals;
  episodes: EpisodeSum[];
  tldr?: { headline: string; bullets: string[]; model: string; costUsd: number };
}

const ZERO: Totals = { costUsd: 0, durationMs: 0, tokens: 0 };
const add = (a: Totals, b: Totals): Totals => ({ costUsd: a.costUsd + b.costUsd, durationMs: a.durationMs + b.durationMs, tokens: a.tokens + b.tokens });
const sub = (a: Totals, b: Totals): Totals => ({ costUsd: a.costUsd - b.costUsd, durationMs: a.durationMs - b.durationMs, tokens: a.tokens - b.tokens });

// Core work only (housekeeping is already out of the headline figures).
function coreTurns(arm: ArmResult) {
  return (arm.attribution?.turns ?? []).filter(t => t.label !== "housekeeping");
}

function turnTotals(t: { costUsd: number; durationMs: number; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number }): Totals {
  return { costUsd: t.costUsd, durationMs: t.durationMs, tokens: t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens };
}

export function computeContextEffect(result: ComparisonResult): ContextEffect | null {
  const { baseline, unblocked, impact } = result;
  if (!baseline.attribution || !unblocked.attribution || !impact?.episodes) return null;
  const totalsOf = (arm: ArmResult) => coreTurns(arm).reduce((acc, t) => add(acc, turnTotals(t)), ZERO);

  const counted: Record<Condition, Set<number>> = { baseline: new Set(), unblocked: new Set() };
  const episodes: EpisodeSum[] = [];
  for (const ep of impact.episodes) {
    const arm = ep.arm === "baseline" ? baseline : unblocked;
    let sum = ZERO;
    for (const t of coreTurns(arm)) {
      if (t.turn < ep.fromTurn || t.turn > ep.toTurn || counted[ep.arm].has(t.turn)) continue;
      counted[ep.arm].add(t.turn);
      sum = add(sum, turnTotals(t));
    }
    episodes.push({ ...ep, ...sum });
  }
  const contextDriven = (c: Condition) => episodes.filter(e => e.arm === c && e.cause === "context").reduce((acc, e) => add(acc, e), ZERO);
  const b = totalsOf(baseline), u = totalsOf(unblocked);
  return { baseline: b, unblocked: u, adjustedBaseline: b, adjustedUnblocked: add(b, sub(contextDriven("unblocked"), contextDriven("baseline"))), episodes };
}

const pct = (from: number, to: number) => (from ? `${to >= from ? "+" : ""}${Math.round(((to - from) / from) * 100)}%` : "n/a");
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const mins = (ms: number) => `${ms < 0 ? "-" : ""}${(Math.abs(ms) / 60000).toFixed(1)} min`;

export function describeNumbers(e: ContextEffect, label: string): string {
  const line = (name: string, b: Totals, u: Totals) =>
    `${name}: cost ${money(b.costUsd)} -> ${money(u.costUsd)} (${pct(b.costUsd, u.costUsd)}); time ${mins(b.durationMs)} -> ${mins(u.durationMs)} (${pct(b.durationMs, u.durationMs)}); tokens ${formatTokens(b.tokens)} -> ${formatTokens(u.tokens)} (${pct(b.tokens, u.tokens)})`;
  return [
    line(`RAW (baseline -> ${label})`, e.baseline, e.unblocked),
    line(`CONTEXT EFFECT ONLY, confounders removed (baseline -> baseline plus the context-driven differences)`, e.adjustedBaseline, e.adjustedUnblocked),
    "EPISODES:",
    ...e.episodes.map(x => `- ${x.arm === "baseline" ? "baseline" : label} T${x.fromTurn}-T${x.toTurn} [${x.cause}] ${x.what}: ${mins(x.durationMs)}, ${money(x.costUsd)}, ${formatTokens(x.tokens)} tokens`),
  ].join("\n");
}

const SCHEMA = {
  type: "object",
  properties: { headline: { type: "string" }, bullets: { type: "array", items: { type: "string" } } },
  required: ["headline", "bullets"],
};

// Plain words for the report's TL;DR, from the computed numbers.
export async function writeTldr(result: ComparisonResult, e: ContextEffect, label: string, model: string): Promise<ContextEffect["tldr"] | null> {
  const im = result.impact!;
  const q = result.quality;
  const p = `Write the TL;DR at the top of a report comparing a coding agent on one task without and with ${label === "Unblocked" ? "Unblocked (a context engine that searches the organisation's PRs, docs, chat and issues)" : "a context engine"}. The reader is a busy engineering leader. Use VERY clear, VERY concise language: no jargon, no hedging, no adjectives that are not numbers.

- headline: one sentence, at most 25 words: the cost, time and token difference ${label === "Unblocked" ? "Unblocked" : "the context"} made, and the quality outcome. Lead with the CONTEXT EFFECT ONLY figures when confounders changed the picture, and say the raw gap came from them.
- bullets: at most 4, each at most 22 words. Explain what drove the cost, time and token numbers, and the role the context played: what it supplied, whether the agent used it, and what differences were NOT caused by it (confounders). Quote numbers exactly as given below. Do not invent facts.

Name the arms "Baseline" and "${label}".

=== NUMBERS (computed; use as given) ===
${describeNumbers(e, label)}

=== QUALITY (blinded judge) ===
${q ? `${q.verdict.better}: ${q.verdict.rationale}` : "(no verdict)"}

=== WHAT THE CONTEXT DID (un-blinded analysis) ===
${im.impact.summary}
Research calls: ${im.research.map(r => `${r.value} (${r.note})`).join("; ") || "none"}
`;
  const res = await runStructured<{ headline: string; bullets: string[] }>("TL;DR", p, model, SCHEMA, 5 * 60 * 1000, false);
  if (!res) return null;
  log(`TL;DR: written; ${formatCost(res.costUsd)} via ${res.modelUsed}`);
  return { headline: res.data.headline.trim(), bullets: res.data.bullets.map(b => b.trim()).filter(Boolean).slice(0, 4), model: res.modelUsed, costUsd: res.costUsd };
}
