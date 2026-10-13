import { expect, test } from "bun:test";
import { buildWalk } from "./attribution.ts";
import { translator as codexTranslator } from "./agents/codex.ts";

test("session input-side totals are split across messages by context size", () => {
  const t = codexTranslator("gpt-6-sol", new Map());
  let ms = Date.parse("2026-09-23T10:00:00Z");
  const lines = [
    { type: "thread.started", thread_id: "t" }, { type: "turn.started" },
    { type: "item.started", item: { id: "a", type: "command_execution", command: "cat big.kt" } },
    { type: "item.completed", item: { id: "a", type: "command_execution", command: "cat big.kt", aggregated_output: "x".repeat(40_000), exit_code: 0 } },
    { type: "item.started", item: { id: "b", type: "command_execution", command: "ls" } },
    { type: "item.completed", item: { id: "b", type: "command_execution", command: "ls", aggregated_output: "ok", exit_code: 0 } },
    { type: "item.completed", item: { id: "m", type: "agent_message", text: "Done." } },
    { type: "turn.completed", usage: { input_tokens: 90_000, cached_input_tokens: 60_000, output_tokens: 500 } },
  ].flatMap(e => t.translate(JSON.stringify(e), (ms += 1000))).map(e => JSON.stringify(e)).join("\n");

  const walk = buildWalk(lines, null);
  expect(walk.length).toBe(3);
  expect(walk.reduce((a, r) => a + r.cacheReadTokens, 0)).toBeCloseTo(60_000, -1);
  expect(walk.reduce((a, r) => a + r.inputTokens, 0)).toBeCloseTo(30_000, -1);
  // After the 40k-character read, messages carry more context.
  expect(walk[1].cacheReadTokens).toBeGreaterThan(walk[0].cacheReadTokens);
});
