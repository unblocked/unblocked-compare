import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { log } from "../util.ts";
import type { Agent } from "./types.ts";
import { runSession, type Translator } from "./session.ts";

const BINARY = process.env.CURSOR_BINARY ?? "agent";

// Names of the MCP servers that are Unblocked, from the global and project
// mcp.json. The contamination guard and the reports key on the name
// "unblocked", so a server configured under another name is renamed to it in
// the canonical transcript.
export function unblockedServers(wtPath: string): string[] {
  const names = new Set<string>();
  for (const file of [path.join(os.homedir(), ".cursor", "mcp.json"), path.join(wtPath, ".cursor", "mcp.json")]) {
    try {
      const servers = JSON.parse(fs.readFileSync(file, "utf8"))?.mcpServers ?? {};
      for (const [name, cfg] of Object.entries(servers as Record<string, { url?: string; command?: string; args?: string[] }>)) {
        const where = [cfg.url, cfg.command, ...(cfg.args ?? [])].join(" ");
        if (/unblocked/i.test(name) || /getunblocked\.com|unblocked/i.test(where)) names.add(name);
      }
    } catch {}
  }
  return [...names];
}

type Raw = Record<string, unknown>;

// Cursor's tool_call payloads are keyed by kind (shellToolCall, readToolCall,
// ...). Map each to the Claude Code tool name and input shape the analysis
// passes read (Bash.command, Read/Edit/Write.file_path, mcp__server__tool).
function canonicalTool(tc: Raw, rename: Map<string, string>): { name: string; input: Raw } {
  const [kind, body] = Object.entries(tc)[0] ?? ["unknown", {}];
  const args = ((body as Raw)?.args ?? {}) as Raw;
  switch (kind) {
    case "shellToolCall": return { name: "Bash", input: { command: args.command ?? "", ...(args.description ? { description: args.description } : {}) } };
    case "readToolCall": return { name: "Read", input: { file_path: args.path ?? "" } };
    case "editToolCall":
    case "strReplaceToolCall": return { name: "Edit", input: { file_path: args.path ?? "", ...(args.oldString !== undefined ? { old_string: args.oldString, new_string: args.newString } : {}) } };
    case "writeToolCall": return { name: "Write", input: { file_path: args.path ?? "", content: args.fileText ?? args.contents ?? "" } };
    case "deleteToolCall": return { name: "Delete", input: { file_path: args.path ?? "" } };
    case "grepToolCall": return { name: "Grep", input: { pattern: args.pattern ?? "", path: args.path ?? "" } };
    case "globToolCall": return { name: "Glob", input: { pattern: args.globPattern ?? args.pattern ?? "" } };
    case "listDirToolCall":
    case "lsToolCall": return { name: "LS", input: { path: args.path ?? "" } };
    case "updateTodosToolCall": return { name: "TodoWrite", input: { todos: args.todos ?? [] } };
    case "webSearchToolCall": return { name: "WebSearch", input: { query: args.searchTerm ?? args.query ?? "" } };
    case "mcpToolCall": {
      let server = String(args.providerIdentifier ?? args.serverName ?? "unknown");
      let tool = String(args.toolName ?? "unknown");
      if (server === "unknown" && typeof args.name === "string" && args.name.includes("-")) {
        const i = args.name.indexOf("-");
        server = args.name.slice(0, i);
        tool = args.name.slice(i + 1);
      }
      return { name: `mcp__${rename.get(server) ?? server}__${tool}`, input: (args.args ?? {}) as Raw };
    }
    default: {
      const name = kind.replace(/ToolCall$/, "");
      return { name: name.charAt(0).toUpperCase() + name.slice(1), input: args };
    }
  }
}

function toolResult(tc: Raw): { content: string; isError: boolean } {
  const [kind, body] = Object.entries(tc)[0] ?? ["unknown", {}];
  const result = ((body as Raw)?.result ?? {}) as Raw;
  const ok = result.success as Raw | undefined;
  if (!ok) return { content: JSON.stringify(result.failure ?? result.error ?? result.rejected ?? result).slice(0, 20_000), isError: true };
  if (kind === "shellToolCall") {
    const out = [ok.stdout, ok.stderr].filter(s => typeof s === "string" && s).join("\n");
    return { content: `${out}${typeof ok.exitCode === "number" && ok.exitCode !== 0 ? `\n(exit ${ok.exitCode})` : ""}`, isError: typeof ok.exitCode === "number" && ok.exitCode !== 0 };
  }
  if (kind === "mcpToolCall") {
    const parts = (ok.content as { text?: { text?: string } | string }[] | undefined) ?? [];
    return { content: parts.map(c => typeof c.text === "string" ? c.text : c.text?.text ?? "").join("\n"), isError: ok.isError === true };
  }
  if (kind === "readToolCall" && typeof ok.content !== "string") return { content: `(${ok.totalLines ?? "?"} lines)`, isError: false };
  return { content: typeof ok.content === "string" ? ok.content : JSON.stringify(ok).slice(0, 4_000), isError: false };
}

// Cursor stream-json → canonical. Assistant text and tool calls from one
// model response share a model_call_id, which becomes the message id.
export function translator(rename: Map<string, string>): Translator {
  let sessionId: string | undefined;
  let model: string | undefined;
  let anon = 0;
  let lastTextMsg = "";
  let finalText = "";
  const msgId = (e: Raw) => `cursor-${typeof e.model_call_id === "string" ? e.model_call_id : `anon-${++anon}`}`;
  const iso = (e: Raw, receivedMs: number) => new Date(typeof e.timestamp_ms === "number" ? e.timestamp_ms : receivedMs).toISOString();
  const assistant = (e: Raw, receivedMs: number, block: Raw) => ({
    type: "assistant", timestamp: iso(e, receivedMs), session_id: sessionId,
    message: { id: msgId(e), role: "assistant", model, content: [block] },
  });

  return {
    translate(line, receivedMs) {
      let e: Raw;
      try { e = JSON.parse(line); } catch { return []; }
      if (typeof e.session_id === "string") sessionId = e.session_id;

      if (e.type === "system" && e.subtype === "init") {
        model = typeof e.model === "string" ? e.model : undefined;
        return [{ type: "system", subtype: "init", timestamp: iso(e, receivedMs), session_id: sessionId, model, cwd: e.cwd }];
      }
      if (e.type === "assistant") {
        const text = ((e.message as Raw)?.content as { type: string; text?: string }[] ?? []).filter(b => b.type === "text" && b.text).map(b => b.text).join("");
        if (!text) return [];
        const out = assistant(e, receivedMs, { type: "text", text });
        finalText = out.message.id === lastTextMsg ? finalText + text : text;
        lastTextMsg = out.message.id;
        return [out];
      }
      if (e.type === "tool_call" && e.subtype === "started") {
        const { name, input } = canonicalTool(e.tool_call as Raw, rename);
        return [assistant(e, receivedMs, { type: "tool_use", id: e.call_id, name, input })];
      }
      if (e.type === "tool_call" && e.subtype === "completed") {
        const { content, isError } = toolResult(e.tool_call as Raw);
        return [{ type: "user", timestamp: iso(e, receivedMs), session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: e.call_id, content, is_error: isError }] } }];
      }
      if (e.type === "result") {
        const u = (e.usage ?? {}) as Record<string, number>;
        return [{
          type: "result", subtype: e.subtype, timestamp: iso(e, receivedMs), session_id: sessionId,
          is_error: e.is_error === true,
          ...(e.is_error === true ? { api_error_status: typeof e.api_error_status === "number" ? e.api_error_status : 0 } : {}),
          duration_ms: e.duration_ms,
          result: finalText || e.result,
          usage: { input_tokens: u.inputTokens ?? 0, output_tokens: u.outputTokens ?? 0, cache_read_input_tokens: u.cacheReadTokens ?? 0, cache_creation_input_tokens: u.cacheWriteTokens ?? 0 },
        }];
      }
      return [];
    },
  };
}

export const cursor: Agent = {
  name: "cursor",
  label: "Cursor",
  cacheWriteTier: "5m",
  // Cursor keys MCP OAuth tokens to the workspace path
  // (~/.cursor/projects/<path>/mcp-auth.json), so a fresh worktree has none and
  // `agent mcp login` needs a browser.
  cliOnly: "Cursor keeps MCP OAuth per workspace path, so the Unblocked MCP server is unauthenticated in a fresh worktree",

  // MCP enablement is per workspace in Cursor (`agent mcp disable` run in the
  // worktree only affects that path), so each arm's fresh worktree gets its
  // own setting and the arms can run in parallel.
  prepareWorktree(wtPath, condition, cliMode) {
    const servers = unblockedServers(wtPath);
    if (!servers.length) {
      if (condition === "unblocked" && !cliMode) log(`[${condition}] ⚠ No Unblocked server in ~/.cursor/mcp.json; the Unblocked arm will likely miss its 120s deadline (use --cli for the Unblocked CLI)`);
      return;
    }
    const verb = condition === "baseline" || cliMode ? "disable" : "enable";
    for (const name of servers) {
      execFileSync(BINARY, ["mcp", verb, name], { cwd: wtPath, stdio: "pipe" });
      log(`[${condition}] Cursor MCP server ${name}: ${verb}d for this worktree`);
    }
  },

  run(opts) {
    const rename = new Map(unblockedServers(opts.worktreePath).map(n => [n, "unblocked"]));
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--yolo",
      "--trust",
      "--approve-mcps",
      "--workspace", opts.worktreePath,
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
      // Cursor has no system-prompt flag; research instructions lead the prompt.
      opts.appendSystemPrompt ? `${opts.appendSystemPrompt}\n\n---\n\n${opts.prompt}` : opts.prompt,
    ];
    return runSession({ ...opts, binary: BINARY, args, translator: translator(rename), keepRaw: true });
  },
};
