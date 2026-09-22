import { describe, expect, test } from "bun:test";
import { costAt, priceFor } from "./util.ts";

const io = (model: string) => { const p = priceFor(model); return [p.input, p.cacheRead, p.output]; };

describe("priceFor", () => {
  test("Anthropic API ids and Claude Code aliases", () => {
    expect(io("claude-opus-5-5")).toEqual([4, 0.2, 20]);
    expect(io("opus")).toEqual([4, 0.2, 20]);
    expect(io("claude-opus-5")).toEqual([5, 0.5, 25]);
    expect(io("claude-opus-4-8")).toEqual([5, 0.5, 25]);
    expect(io("claude-opus-4-1-20250805")).toEqual([15, 1.5, 75]);
    expect(io("claude-fable-5-1")).toEqual([10, 0.25, 50]);
    expect(io("fable")).toEqual([10, 0.25, 50]);
    expect(io("claude-fable-5")).toEqual([10, 1, 50]);
    expect(io("claude-sonnet-5")).toEqual([2, 0.2, 10]);
    expect(io("sonnet")).toEqual([2, 0.2, 10]);
    expect(io("claude-sonnet-4-5-20250929")).toEqual([3, 0.3, 15]);
    expect(io("claude-haiku-4-5-20251001")).toEqual([1, 0.1, 5]);
  });

  test("OpenAI ids", () => {
    expect(io("gpt-6-astra")).toEqual([10, 1, 50]);
    expect(io("gpt-6-sol")).toEqual([2, 0.2, 10]);
    expect(io("gpt-6-luna")).toEqual([0.1, 0.01, 0.5]);
    expect(io("gpt-5.6-terra")).toEqual([2, 0.2, 12]);
    expect(io("gpt-5.5")).toEqual([5, 0.5, 30]);
    expect(io("gpt-5.4-mini")).toEqual([0.75, 0.075, 4.5]);
    expect(io("gpt-5.3-codex")).toEqual([1.75, 0.175, 14]);
    expect(io("gpt-5-codex")).toEqual([1.25, 0.125, 10]);
  });

  test("Cursor display names", () => {
    expect(io("Claude Opus 4.7 300K Extra High")).toEqual([5, 0.5, 25]);
    expect(io("Opus 4.7 (Thinking) 300K Extra High")).toEqual([5, 0.5, 25]);
    expect(io("Claude Opus 5 1M Thinking Fast")).toEqual([10, 1, 50]);
    expect(io("Sonnet 4.6 (Thinking) 200K Medium")).toEqual([3, 0.3, 15]);
    expect(io("Codex 5.3 Fast")).toEqual([3.5, 0.35, 28]);
    expect(io("Codex 5.3 Low")).toEqual([1.75, 0.175, 14]);
    expect(io("GPT-5.2")).toEqual([1.75, 0.175, 14]);
    expect(io("Composer 2.5")).toEqual([0.5, 0.2, 2.5]);
    expect(io("Grok 4.7")).toEqual([2, 0.5, 6]);
  });

  test("cache writes: Anthropic 5m and 1h tiers", () => {
    const p = priceFor("claude-opus-5-5");
    const u = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000 };
    expect(costAt(p, u, "5m")).toBe(5);
    expect(costAt(p, u, "1h")).toBe(8);
  });
});
