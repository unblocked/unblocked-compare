export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

// Cents once a figure reaches ten cents; smaller figures keep four places so
// a cheap call does not read as $0.00.
export function formatCost(usd: number): string {
  return `$${usd.toFixed(Math.abs(usd) >= 0.1 ? 2 : 4)}`;
}

export function formatTokens(n: number): string {
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 999.95) return `${(n / 1_000).toFixed(1)}k`;
  return Math.round(n).toString();
}

export function formatDiffSummary(d: { filesChanged: number; linesAdded: number; linesRemoved: number; commits: number; truncated?: boolean }): string {
  const commits = d.commits ? `, ${d.commits} commit${d.commits === 1 ? "" : "s"} by agent` : "";
  const trunc = d.truncated ? ", diff text truncated" : "";
  return `${d.filesChanged} files, +${d.linesAdded} -${d.linesRemoved}${commits}${trunc}`;
}

export function log(message: string): void {
  const timestamp = new Date().toLocaleTimeString();
  process.stderr.write(`[${timestamp}] ${message}\n`);
}

export function padRight(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + " ".repeat(width - str.length);
}

export function padLeft(str: string, width: number): string {
  return str.length >= width ? str : " ".repeat(width - str.length) + str;
}

// Per-token API pricing ($/M tokens), checked 2026-09-22 against:
//   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI     https://developers.openai.com/api/docs/pricing
//   Cursor     https://cursor.com/docs/models (third-party models at the
//              providers' API rates; Teams/Enterprise add $0.25/M, not modelled)
// Claude Code reports its own cost, so this prices Cursor and Codex runs (which
// report tokens only) and the per-term cost breakdown. Not modelled: OpenAI's
// long-context rates (above 272K input tokens in one request), which a
// per-session token total cannot reveal.
export interface ModelPrice { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }

// Anthropic: 5m cache write 1.25x input, 1h cache write 2x input.
const anthropic = (input: number, output: number, cacheRead = input / 10): ModelPrice =>
  ({ input, output, cacheRead, cacheWrite: input * 1.25, cacheWrite1h: input * 2 });
// OpenAI and Cursor-native models: one cache-write rate, 0 where none is charged.
const flat = (input: number, output: number, cacheRead: number, cacheWrite = 0): ModelPrice =>
  ({ input, output, cacheRead, cacheWrite, cacheWrite1h: cacheWrite });

// Matched in order against the normalised model id (lowercase, runs of
// spaces, dots, underscores and brackets turned into "-"), so API ids
// ("claude-opus-5-5", "gpt-6-sol"), Claude Code aliases ("opus") and Cursor's
// display names ("Claude Opus 4.7 300K Extra High", "Codex 5.3 Fast") all
// resolve. Fast variants come before their base model.
const PRICES: [RegExp, ModelPrice][] = [
  // Anthropic
  [/fable-5-1|mythos-5-1|^fable$/, anthropic(10, 50, 0.25)],
  [/fable|mythos/, anthropic(10, 50, 1)],
  [/opus-5-5.*fast/, anthropic(8, 40, 0.4)],
  [/opus-5-5|^opus$/, anthropic(4, 20, 0.2)],
  [/opus-(5|4-8).*fast/, anthropic(10, 50)],
  [/opus-4-7.*fast/, anthropic(30, 150)], // Cursor-only; not offered on Anthropic's API
  [/opus-4-(1|0)|opus-4$|opus-4-2025/, anthropic(15, 75)],
  [/opus/, anthropic(5, 25)],
  [/sonnet-5|^sonnet$/, anthropic(2, 10)],
  [/sonnet/, anthropic(3, 15)],
  [/haiku-3/, anthropic(0.8, 4)],
  [/haiku/, anthropic(1, 5)],
  // OpenAI. Fast mode is 2x throughout.
  [/gpt-6-astra.*fast/, flat(20, 100, 2, 25)],
  [/gpt-6-astra/, flat(10, 50, 1, 12.5)],
  [/gpt-6-sol/, flat(2, 10, 0.2, 2.5)],
  [/gpt-6-luna/, flat(0.1, 0.5, 0.01, 0.125)],
  [/gpt-5-6-sol/, flat(4, 20, 0.4, 5)],
  [/gpt-5-6-terra/, flat(2, 12, 0.2, 2.5)],
  [/gpt-5-6-luna/, flat(0.2, 1.2, 0.02, 0.25)],
  [/gpt-5-5-pro/, flat(30, 180, 30)],
  [/gpt-5-5/, flat(5, 30, 0.5)],
  [/gpt-5-4-pro/, flat(30, 180, 30)],
  [/gpt-5-4-mini/, flat(0.75, 4.5, 0.075)],
  [/gpt-5-4-nano/, flat(0.2, 1.25, 0.02)],
  [/gpt-5-4/, flat(2.5, 15, 0.25)],
  [/(gpt-5-3-codex|codex-5-3).*fast/, flat(3.5, 28, 0.35)],
  [/gpt-5-3-codex|codex-5-3|gpt-5-2|codex-5-2/, flat(1.75, 14, 0.175)],
  [/(gpt-5-1-)?codex-mini|gpt-5-mini/, flat(0.25, 2, 0.025)],
  [/gpt-5.*fast/, flat(2.5, 20, 0.25)],
  [/gpt-5|codex/, flat(1.25, 10, 0.125)],
  // Cursor's own models (Cursor Models pool)
  [/composer.*fast/, flat(3, 15, 0.5)],
  [/composer/, flat(0.5, 2.5, 0.2)],
  [/grok-4-7-500k.*fast/, flat(6, 18, 1.5)],
  [/grok.*(fast|500k)/, flat(4, 12, 1)],
  [/grok/, flat(2, 6, 0.5)],
  // Google, as Cursor bills them
  [/gemini-3-[78]-flash/, flat(0.75, 3.5, 0.075)],
  [/gemini-3-6-flash/, flat(1.5, 7.5, 0.15)],
  [/gemini-3-5-flash/, flat(1.5, 9, 0.15)],
  [/gemini-3(-1)?-pro/, flat(2, 12, 0.2)],
];

const FALLBACK = anthropic(2, 10); // Sonnet 5
const unpriced = new Set<string>();

export function normaliseModel(model: string): string {
  return model.toLowerCase().replace(/[\s._()]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function priceFor(model: string): ModelPrice {
  const id = normaliseModel(model);
  for (const [re, price] of PRICES) if (re.test(id)) return price;
  if (!unpriced.has(model)) {
    unpriced.add(model);
    log(`⚠ No price for model "${model}"; estimating its cost at Claude Sonnet 5 rates. Add it to PRICES in src/util.ts.`);
  }
  return FALLBACK;
}

// Which cache-write rate a CLI's writes are billed at. Claude Code writes 1h
// cache entries; Cursor bills cache writes at the 5m rate.
export type CacheWriteTier = "5m" | "1h";

export interface TokenUsageLike {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function effectiveInputTokens(u: TokenUsageLike): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

export function totalTokens(u: TokenUsageLike): number {
  return effectiveInputTokens(u) + u.outputTokens;
}

// Fresh input + output, for the console's per-model rows, which show cache
// reads beside it. The reports' headline token figure is every token
// (totalTokens), matching the Summary.
export function uncachedTokens(u: TokenUsageLike): number {
  return u.inputTokens + u.outputTokens;
}

export function cacheWriteRate(p: ModelPrice, tier: CacheWriteTier = "1h"): number {
  return tier === "5m" ? p.cacheWrite : p.cacheWrite1h;
}

export function costAt(p: ModelPrice, u: TokenUsageLike, tier: CacheWriteTier = "1h"): number {
  return (u.inputTokens / 1_000_000) * p.input
    + (u.outputTokens / 1_000_000) * p.output
    + (u.cacheReadTokens / 1_000_000) * p.cacheRead
    + (u.cacheCreationTokens / 1_000_000) * cacheWriteRate(p, tier);
}

export function modelCost(model: string, mu: TokenUsageLike & { costUsd?: number }, tier: CacheWriteTier = "1h"): number {
  return typeof mu.costUsd === "number" ? mu.costUsd : costAt(priceFor(model), mu, tier);
}

export function estimateCost(model: string, u: TokenUsageLike & { byModel?: Record<string, TokenUsageLike & { costUsd?: number }> }, tier: CacheWriteTier = "1h"): number {
  if (u.byModel && Object.keys(u.byModel).length > 0) {
    let total = 0;
    for (const [m, mu] of Object.entries(u.byModel)) total += modelCost(m, mu, tier);
    return total;
  }
  return costAt(priceFor(model), u, tier);
}
