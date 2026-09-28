import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseStreamJson } from "../transcript.ts";
import { discountEngineTime } from "./discount.ts";

const ENGINE = "/tmp/uc-engine-x/bin/unblocked";
const at = (s: number) => new Date(Date.UTC(2026, 8, 23, 10, 0, s)).toISOString();

test("each engine call counts as at most the cap; later events move back", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "disc-")), "unblocked.jsonl");
  const events = [
    { type: "harness", subtype: "session_start", timestamp: at(0) },
    { type: "assistant", timestamp: at(1), message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `${ENGINE} context-research -q x` } }] } },
    { type: "user", timestamp: at(61), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }] } },     // 60s call
    { type: "assistant", timestamp: at(63), message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }] } },
    { type: "user", timestamp: at(64), message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "a" }] } },
    { type: "assistant", timestamp: at(65), message: { id: "m3", content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: `${ENGINE} context-research -q y` } }] } },
    { type: "user", timestamp: at(75), message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "r" }] } },     // 10s: under the cap
    { type: "result", timestamp: at(76), duration_ms: 76_000, usage: {} },
  ];
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join("\n"));

  expect(discountEngineTime(file, ENGINE)).toBe(40_000);
  const p = parseStreamJson(fs.readFileSync(file, "utf8"), null, true);
  expect(p.toolCalls.map(t => t.durationMs)).toEqual([20_000, 1_000, 10_000]);
  expect(p.cliDurationMs).toBe(36_000);
  expect(fs.existsSync(file.replace(".jsonl", ".unadjusted.jsonl"))).toBe(true);
  // A bare `unblocked` is not the engine, and a saved run matches by path.
  expect(discountEngineTime(file, "/elsewhere/unblocked")).toBe(0);
});
