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
import { formatCost, formatDuration, formatTokens, log } from "./util.ts";
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

// How the measured difference splits, exactly: the context's influence, the
// models' own mistakes and environment noise (each arm's agent and
// environment episodes), and the rest (ordinary work both arms did, in
// different amounts, that no episode covers).
export interface Reconciliation { measured: number; influence: number; ownMistakes: number; other: number }
export function reconcile(e: ContextEffect, key: keyof Totals): Reconciliation {
  const own = (arm: Condition) => e.episodes.filter(x => x.arm === arm && x.cause !== "context").reduce((s, x) => s + x[key], 0);
  const measured = e.unblocked[key] - e.baseline[key];
  const influence = e.adjustedUnblocked[key] - e.adjustedBaseline[key];
  const ownMistakes = own("unblocked") - own("baseline");
  return { measured, influence, ownMistakes, other: measured - influence - ownMistakes };
}

const pct = (from: number, to: number) => (from ? `${to >= from ? "+" : ""}${Math.round(((to - from) / from) * 100)}%` : "n/a");
// Formatted exactly as the report shows them, so the Summary quotes the page.
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const dur = (ms: number) => `${ms < 0 ? "-" : ""}${formatDuration(Math.abs(ms))}`;
const tok = (n: number) => `${n < 0 ? "-" : ""}${formatTokens(Math.abs(n))}`;
const sgn = (n: number, f: (n: number) => string) => (n >= 0 ? "+" : "") + f(n);

export function describeNumbers(e: ContextEffect, label: string): string {
  const line = (name: string, b: Totals, u: Totals) =>
    `${name}: cost ${money(b.costUsd)} -> ${money(u.costUsd)} (${pct(b.costUsd, u.costUsd)}); time ${dur(b.durationMs)} -> ${dur(u.durationMs)} (${pct(b.durationMs, u.durationMs)}); tokens ${tok(b.tokens)} -> ${tok(u.tokens)} (${pct(b.tokens, u.tokens)})`;
  const split = (key: keyof Totals, f: (n: number) => string) => {
    const r = reconcile(e, key);
    return `${sgn(r.measured, f)} measured = ${sgn(r.influence, f)} context's influence ${sgn(r.ownMistakes, f)} agents' own mistakes ${sgn(r.other, f)} other work`;
  };
  const ctx = (arm: Condition) => e.episodes.filter(x => x.arm === arm && x.cause === "context");
  const own = (arm: Condition) => e.episodes.filter(x => x.arm === arm && x.cause !== "context");
  const sum = (xs: EpisodeSum[]) => `${money(xs.reduce((t, x) => t + x.costUsd, 0))}, ${dur(xs.reduce((t, x) => t + x.durationMs, 0))}, ${tok(xs.reduce((t, x) => t + x.tokens, 0))} tokens`;
  return [
    line(`MEASURED (baseline -> ${label}, core work)`, e.baseline, e.unblocked),
    line(`CONTEXT'S INFLUENCE (baseline -> baseline + ${label} arm's context episodes - baseline's context episodes)`, e.adjustedBaseline, e.adjustedUnblocked),
    `${label} arm's context episodes total: ${sum(ctx("unblocked"))}`,
    `Baseline's context episodes (work the baseline agent did for lack of the context) total: ${sum(ctx("baseline"))}`,
    `${label} agent's own mistakes and environment noise ([agent]/[environment] episodes in its arm) total: ${sum(own("unblocked"))}`,
    `Baseline agent's own mistakes and environment noise total: ${sum(own("baseline"))}`,
    `SPLIT, cost: ${split("costUsd", money)}`,
    `SPLIT, time: ${split("durationMs", dur)}`,
    `SPLIT, tokens: ${split("tokens", tok)}`,
    "EPISODES:",
    ...e.episodes.map(x => `- ${x.arm === "baseline" ? "baseline" : label} T${x.fromTurn}-T${x.toTurn} [${x.cause}] ${x.what}: ${money(x.costUsd)}, ${dur(x.durationMs)}, ${tok(x.tokens)} tokens`),
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

- headline: one sentence, at most 25 words, about ${label === "Unblocked" ? "Unblocked's" : "the"} context only: what it brought (the quality outcome it made possible, and its influence on cost, time and tokens, from the CONTEXT'S INFLUENCE line), or, when it did not help, why not. Do not mention the agents' own mistakes, other work, measured figures or the baseline's errors: the report explains those below the headline.
- bullets: at most 4, each at most 22 words. The FIRST bullet explains the quality outcome: which requirement or defect decided it, or why it tied, and whether the context made the difference. The others explain what drove the cost, time and token numbers, and the context's influence: what it supplied, which turns it shaped for better or worse, and which differences were the models' own choices it did not influence. Quote numbers exactly as given below. Do not invent facts.

Who did what, strictly:
- ${label === "Unblocked" ? "Unblocked" : "The context engine"} only supplies context. It never writes code, runs builds, makes choices or makes mistakes. Say "${label === "Unblocked" ? "Unblocked's" : "the"} context supplied / pointed to / drove ...".
- The coding agent does the work in both arms: every build, test, fix, choice and mistake is the agent's. Say "the agent" when it is clear which arm, else "the agent with ${label === "Unblocked" ? "Unblocked" : "the context"}" or "the baseline agent". Never attribute an action or a mistake to ${label === "Unblocked" ? "Unblocked" : "the context engine"}.
- State the context's influence as what happened, not a hypothetical: "drove cost down by 10%", never "would cut".
- Episode labels are fixed; follow them, never reinterpret them. A baseline [context] episode is work the baseline agent did for lack of the context: say so. A [agent] or [environment] episode is one the context did not influence, in either arm.
- Requirements are met or missed by an agent, never by ${label === "Unblocked" ? "Unblocked" : "the context"}: "the agent with ${label === "Unblocked" ? "Unblocked" : "the context"} met both requirements".
- A MEASURED percentage is the whole difference between the arms. Never attribute a measured percentage to mistakes or to the context; the SPLIT lines say how much of it each part explains.
- "Agents' own mistakes" in SPLIT is a net figure: the ${label} agent's own mistakes minus the baseline agent's. When it is negative, the baseline agent's own mistakes cost more: say "the baseline agent's own mistakes added $X to the baseline", using the per-arm totals.
- Quote numbers only from NUMBERS, character for character (for example "$0.18", "25s", "60.2k tokens"). Do not convert units, round or add figures together yourself.
Style example: "${label === "Unblocked" ? "Unblocked's" : "The"} context drove cost down by 10%, time by 2%, and tokens by 12%, but the agent made judgement errors that drove raw numbers up."

=== NUMBERS (computed; use as given) ===
${describeNumbers(e, label)}

=== QUALITY (blinded judge) ===
${q ? `${q.verdict.better}: ${q.verdict.rationale}${q.verdict.tieBreaker?.applied ? ` (blinded tie, broken by the tie-breaker: ${q.verdict.tieBreaker.reason})` : ""}
Requirements: ${q.requirements.map(r => `"${r.requirement}" Baseline ${r.baseline.status}, ${label} ${r.unblocked.status}`).join("; ")}` : "(no verdict)"}

=== WHAT THE CONTEXT DID (un-blinded analysis) ===
${im.impact.summary}
Research calls: ${im.research.map(r => `${r.value} (${r.note})`).join("; ") || "none"}
`;
  const res = await runStructured<{ headline: string; bullets: string[] }>("TL;DR", p, model, SCHEMA, 5 * 60 * 1000, false);
  if (!res) return null;
  log(`TL;DR: written; ${formatCost(res.costUsd)} via ${res.modelUsed}`);
  return { headline: res.data.headline.trim(), bullets: res.data.bullets.map(b => b.trim()).filter(Boolean).slice(0, 4), model: res.modelUsed, costUsd: res.costUsd };
}
