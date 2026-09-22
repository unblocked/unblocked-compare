import { describe, expect, test } from "bun:test";
import { parseStreamJson } from "../transcript.ts";
import { extractUnblockedCalls } from "../runner.ts";
import { translator as cursorTranslator } from "./cursor.ts";
import { translator as codexTranslator, unblockedServers, unwrapShell } from "./codex.ts";
import type { Translator } from "./session.ts";

function canonical(t: Translator, events: object[]): string {
  let ms = Date.parse("2026-09-22T10:00:00Z");
  return events.flatMap(e => t.translate(JSON.stringify(e), (ms += 1000))).map(e => JSON.stringify(e)).join("\n");
}

describe("cursor translator", () => {
  const sid = "s-1";
  const events = [
    { type: "system", subtype: "init", session_id: sid, model: "Opus 4.7 (Thinking)", cwd: "/wt" },
    { type: "assistant", session_id: sid, model_call_id: "m1", timestamp_ms: 1000, message: { content: [{ type: "text", text: "Researching." }] } },
    { type: "tool_call", subtype: "started", call_id: "c1", model_call_id: "m1", timestamp_ms: 1100, tool_call: { mcpToolCall: { args: { providerIdentifier: "ub-prod", toolName: "context_research", args: { query: "how are models added" } } } } },
    { type: "tool_call", subtype: "completed", call_id: "c1", model_call_id: "m1", timestamp_ms: 4100, tool_call: { mcpToolCall: { args: {}, result: { success: { content: [{ text: { text: "**Title**: PR 1" } }] } } } } },
    { type: "tool_call", subtype: "started", call_id: "c2", model_call_id: "m2", timestamp_ms: 5000, tool_call: { shellToolCall: { args: { command: "bun test" } } } },
    { type: "tool_call", subtype: "completed", call_id: "c2", model_call_id: "m2", timestamp_ms: 7000, tool_call: { shellToolCall: { args: { command: "bun test" }, result: { success: { stdout: "1 fail", stderr: "", exitCode: 1 } } } } },
    { type: "tool_call", subtype: "started", call_id: "c3", model_call_id: "m3", timestamp_ms: 8000, tool_call: { editToolCall: { args: { path: "/wt/a.ts" } } } },
    { type: "assistant", session_id: sid, model_call_id: "m4", timestamp_ms: 9000, message: { content: [{ type: "text", text: "Done: " }] } },
    { type: "assistant", session_id: sid, model_call_id: "m4", timestamp_ms: 9001, message: { content: [{ type: "text", text: "added X." }] } },
    { type: "result", subtype: "success", session_id: sid, duration_ms: 9000, is_error: false, result: "Researching.Done: added X.", usage: { inputTokens: 10, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 400 } },
  ];
  const p = parseStreamJson(canonical(cursorTranslator(new Map([["ub-prod", "unblocked"]])), events), null, true);

  test("groups a model call into one message", () => expect(p.assistantTurns).toBe(4));
  test("maps tools to canonical names", () => expect(p.toolCalls.map(t => t.name)).toEqual(["mcp__unblocked__context_research", "Bash", "Edit"]));
  test("renames the Unblocked server so the guard sees it", () => expect(extractUnblockedCalls(p.toolCalls)).toEqual([{ tool: "context_research", query: "how are models added" }]));
  test("times tool calls from Cursor's timestamps", () => expect(p.toolCalls[0].durationMs).toBe(3000));
  test("takes usage from the result event", () => expect(p.tokenUsage).toMatchObject({ inputTokens: 10, outputTokens: 200, cacheReadTokens: 3000, cacheCreationTokens: 400 }));
  test("final response is the last message's text, not Cursor's concatenation", () => expect(p.finalResponse).toBe("Done: added X."));
  test("records the model and session", () => { expect(p.model).toBe("Opus 4.7 (Thinking)"); expect(p.sessionId).toBe(sid); });
});

describe("codex translator", () => {
  const events = [
    { type: "thread.started", thread_id: "t-1" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "i0", type: "agent_message", text: "Plan." } },
    { type: "item.started", item: { id: "i1", type: "mcp_tool_call", server: "unblocked", tool: "context_research", arguments: { query: "hello" }, status: "in_progress" } },
    { type: "item.started", item: { id: "i2", type: "command_execution", command: "/bin/zsh -lc 'unblocked context-research --query '\\''x'\\'''", status: "in_progress" } },
    { type: "item.completed", item: { id: "i2", type: "command_execution", command: "/bin/zsh -lc 'unblocked context-research --query '\\''x'\\'''", aggregated_output: "ok\n", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "i1", type: "mcp_tool_call", server: "unblocked", tool: "context_research", arguments: { query: "hello" }, result: { content: [{ type: "text", text: "**Title**: a" }] }, status: "completed" } },
    { type: "item.completed", item: { id: "i3", type: "file_change", changes: [{ path: "/wt/hello.txt", kind: "add" }], status: "completed" } },
    { type: "item.completed", item: { id: "i4", type: "agent_message", text: "Created hello.txt." } },
    { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 700, output_tokens: 50 } },
  ];
  const p = parseStreamJson(canonical(codexTranslator("gpt-5.5", new Map([["unblocked", "unblocked"]])), events), null, true);

  test("starts a new message at model output after a tool result", () => expect(p.assistantTurns).toBe(3));
  test("maps items to canonical tools, unwrapping the login shell", () => {
    expect(p.toolCalls.map(t => t.name)).toEqual(["mcp__unblocked__context_research", "Bash", "Write"]);
    expect(p.toolCalls[1].args.command).toBe("unblocked context-research --query 'x'");
  });
  test("detects MCP and CLI Unblocked calls", () => expect(extractUnblockedCalls(p.toolCalls).map(c => c.tool)).toEqual(["context_research", "context-research"]));
  test("splits cached tokens out of input_tokens", () => expect(p.tokenUsage).toMatchObject({ inputTokens: 300, cacheReadTokens: 700, outputTokens: 50 }));
  test("final response and duration", () => { expect(p.finalResponse).toBe("Created hello.txt."); expect(p.cliDurationMs).toBe(8000); });
  test("a failed turn is an API error", () => {
    const failed = parseStreamJson(canonical(codexTranslator(undefined, new Map()), [
      { type: "thread.started", thread_id: "t-2" }, { type: "turn.started" },
      { type: "turn.failed", error: { message: "{\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"bad model\"}}" } },
    ]), null, true);
    expect(failed.apiError).toStartWith("API error 400");
  });
});

describe("codex helpers", () => {
  test("unwrapShell", () => {
    expect(unwrapShell("/bin/zsh -lc 'cat a.txt'")).toBe("cat a.txt");
    expect(unwrapShell("/bin/bash -lc \"echo \\\"hi\\\"\"")).toBe("echo \"hi\"");
    expect(unwrapShell("git status")).toBe("git status");
  });
  test("unblockedServers finds servers by name or URL", () => {
    const toml = `model = "gpt-5.5"\n\n[mcp_servers.notion]\nurl = "https://mcp.notion.com/mcp"\n\n[mcp_servers.unblocked]\nenabled = true\nurl = "https://getunblocked.com/api/mcpsse"\n\n[mcp_servers.ctx]\nurl = "https://getunblocked.com/api/mcp"\n`;
    expect(unblockedServers(toml)).toEqual(["unblocked", "ctx"]);
  });
});
