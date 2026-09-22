import { describe, expect, test } from "bun:test";
import { ToolRecorder } from "./tools.ts";

const feedAll = (r: ToolRecorder, events: object[]) => { for (const e of events) r.feed(JSON.stringify(e)); return r.calls(); };

describe("ToolRecorder", () => {
  test("Claude stream-json: categories, labels, MCP query, duration", () => {
    const calls = feedAll(new ToolRecorder("claude"), [
      { type: "system", subtype: "init", session_id: "s", model: "claude-sonnet-5" },
      { type: "assistant", timestamp: "2026-09-22T10:00:00.000Z", message: { id: "m1", content: [
        { type: "tool_use", id: "t1", name: "mcp__unblocked__context_research", input: { query: "clamp conventions" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "bun test" } },
      ] } },
      { type: "user", timestamp: "2026-09-22T10:00:04.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } },
      { type: "user", timestamp: "2026-09-22T10:00:02.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } },
    ]);
    expect(calls.map(c => c.category)).toEqual(["Unblocked", "Bash"]);
    expect(calls[0]).toMatchObject({ isMcp: true, mcpServer: "unblocked", query: "clamp conventions", durationMs: 4000 });
    expect(calls[1]).toMatchObject({ label: "Bash: bun test", durationMs: 2000 });
  });

  test("Codex events are translated before counting", () => {
    const calls = feedAll(new ToolRecorder("codex"), [
      { type: "thread.started", thread_id: "t" },
      { type: "item.started", item: { id: "i1", type: "command_execution", command: "/bin/zsh -lc 'cat math.ts'" } },
      { type: "item.completed", item: { id: "i1", type: "command_execution", command: "/bin/zsh -lc 'cat math.ts'", aggregated_output: "", exit_code: 0 } },
      { type: "item.completed", item: { id: "i2", type: "mcp_tool_call", server: "notion", tool: "search", arguments: { query: "math" } } },
    ]);
    expect(calls.map(c => [c.category, c.label])).toEqual([["Bash", "Bash: cat math.ts"], ["MCP:notion", "MCP:notion: math"]]);
  });
});
