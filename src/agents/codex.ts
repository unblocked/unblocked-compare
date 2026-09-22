import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Agent } from "./types.ts";
import { runSession, type Translator } from "./session.ts";

const BINARY = process.env.CODEX_BINARY ?? "codex";
const CONFIG = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml");

function readConfig(): string {
  try { return fs.readFileSync(CONFIG, "utf8"); } catch { return ""; }
}

// The top-level `model = "..."` in config.toml: what Codex runs when --model
// is not given, recorded so the report and pricing name the real model.
function configuredModel(toml: string): string | undefined {
  const top = toml.split(/^\s*\[/m)[0];
  return top.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
}

// Names of the [mcp_servers.<name>] tables that are Unblocked, by name or URL.
export function unblockedServers(toml: string): string[] {
  const names: string[] = [];
  const re = /^\s*\[mcp_servers\.("?)([^\]."]+)\1\]\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(toml))) {
    const name = m[2];
    const body = toml.slice(re.lastIndex).split(/^\s*\[/m)[0];
    if (/unblocked/i.test(name) || /getunblocked\.com/i.test(body)) names.push(name);
  }
  return names;
}

// `codex exec` runs commands through a login shell: `/bin/zsh -lc 'cmd'`.
// Unwrap it so the command reads as the agent wrote it (the contamination
// guard and the verification record match on the command's start).
export function unwrapShell(command: string): string {
  const m = command.match(/^\S*\/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  if (!m) return command;
  return m[1] === "'" ? m[2].replace(/'\\''/g, "'") : m[2].replace(/\\(["\\$`])/g, "$1");
}

type Item = Record<string, unknown> & { id: string; type: string };

// codex exec --json → canonical. Codex events carry no timestamps and no
// message boundaries, so the arrival time stands in for the former, and a
// new assistant message starts at the first model output after a tool result.
export function translator(model: string | undefined, rename: Map<string, string>): Translator {
  let sessionId: string | undefined;
  let msgSeq = 0;
  let msgId = "";
  let resultSinceMsg = true;
  let turnStartMs = 0;
  let finalText = "";
  const opened = new Set<string>();
  const iso = (ms: number) => new Date(ms).toISOString();
  const assistant = (ms: number, block: object) => {
    if (resultSinceMsg || !msgId) { msgId = `codex-${sessionId ?? "session"}-${++msgSeq}`; resultSinceMsg = false; }
    return { type: "assistant", timestamp: iso(ms), session_id: sessionId, message: { id: msgId, role: "assistant", model, content: [block] } };
  };
  const toolResult = (ms: number, id: string, content: string, isError: boolean) => {
    resultSinceMsg = true;
    return { type: "user", timestamp: iso(ms), session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } };
  };
  const toolUse = (item: Item): { name: string; input: Record<string, unknown> } | null => {
    switch (item.type) {
      case "command_execution": return { name: "Bash", input: { command: unwrapShell(String(item.command ?? "")) } };
      case "file_change": {
        const changes = (item.changes as { path: string; kind: string }[] | undefined) ?? [];
        return { name: changes.length && changes.every(c => c.kind === "add") ? "Write" : "Edit", input: { file_path: changes.map(c => c.path).join(", "), changes } };
      }
      case "mcp_tool_call": {
        const server = String(item.server ?? "unknown");
        return { name: `mcp__${rename.get(server) ?? server}__${String(item.tool ?? "unknown")}`, input: (item.arguments ?? {}) as Record<string, unknown> };
      }
      case "web_search": return { name: "WebSearch", input: { query: item.query ?? "" } };
      case "todo_list": return { name: "TodoWrite", input: { todos: item.items ?? [] } };
      default: return null;
    }
  };
  const resultOf = (item: Item): { content: string; isError: boolean } => {
    switch (item.type) {
      case "command_execution": {
        const code = item.exit_code;
        return { content: `${String(item.aggregated_output ?? "")}${typeof code === "number" && code !== 0 ? `\n(exit ${code})` : ""}`, isError: typeof code === "number" && code !== 0 };
      }
      case "file_change": return { content: ((item.changes as { path: string; kind: string }[] | undefined) ?? []).map(c => `${c.kind} ${c.path}`).join("\n"), isError: item.status === "failed" };
      case "mcp_tool_call": {
        if (item.error) return { content: JSON.stringify(item.error), isError: true };
        const parts = ((item.result as { content?: { text?: string }[] } | null)?.content) ?? [];
        return { content: parts.map(p => p.text ?? "").join("\n"), isError: false };
      }
      default: return { content: "", isError: item.status === "failed" };
    }
  };

  return {
    translate(line, receivedMs) {
      let e: Record<string, unknown>;
      try { e = JSON.parse(line); } catch { return []; }
      const item = e.item as Item | undefined;
      switch (e.type) {
        case "thread.started":
          sessionId = String(e.thread_id);
          return [{ type: "system", subtype: "init", timestamp: iso(receivedMs), session_id: sessionId, model }];
        case "turn.started":
          turnStartMs = receivedMs;
          return [];
        case "item.started":
        case "item.completed": {
          if (!item) return [];
          if (item.type === "agent_message") {
            if (e.type !== "item.completed" || !item.text) return [];
            finalText = String(item.text);
            return [assistant(receivedMs, { type: "text", text: finalText })];
          }
          if (item.type === "reasoning") {
            return e.type === "item.completed" && item.text ? [assistant(receivedMs, { type: "thinking", thinking: String(item.text) })] : [];
          }
          const use = toolUse(item);
          if (!use) return [];
          const out: object[] = [];
          if (!opened.has(item.id)) { opened.add(item.id); out.push(assistant(receivedMs, { type: "tool_use", id: item.id, ...use })); }
          if (e.type === "item.completed") { const r = resultOf(item); out.push(toolResult(receivedMs, item.id, r.content, r.isError)); }
          return out;
        }
        case "turn.completed": {
          // input_tokens includes the cached ones; the canonical usage counts them apart.
          const u = (e.usage ?? {}) as Record<string, number>;
          const cached = u.cached_input_tokens ?? 0;
          return [{
            type: "result", subtype: "success", timestamp: iso(receivedMs), session_id: sessionId, is_error: false,
            duration_ms: turnStartMs ? receivedMs - turnStartMs : undefined, result: finalText,
            usage: { input_tokens: Math.max(0, (u.input_tokens ?? 0) - cached), output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 },
          }];
        }
        case "turn.failed": {
          const msg = String((e.error as { message?: string } | undefined)?.message ?? "turn failed");
          const status = Number(msg.match(/"status"\s*:\s*(\d+)/)?.[1] ?? 0);
          return [{ type: "result", subtype: "error", timestamp: iso(receivedMs), session_id: sessionId, is_error: true, api_error_status: status, result: msg, duration_ms: turnStartMs ? receivedMs - turnStartMs : undefined }];
        }
        default:
          return [];
      }
    },
  };
}

export const codex: Agent = {
  name: "codex",
  label: "Codex",

  // Blocking is per invocation (-c mcp_servers.<name>.enabled=false).
  prepareWorktree() {},

  run(opts) {
    const toml = readConfig();
    const servers = unblockedServers(toml);
    const model = opts.model ?? configuredModel(toml);
    const off = opts.blockUnblocked || opts.cliMode ? servers.flatMap(n => ["-c", `mcp_servers.${n}.enabled=false`]) : [];
    const common = ["--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", ...(opts.model ? ["-m", opts.model] : []), ...off];
    const args = opts.resumeSessionId
      ? ["exec", "resume", ...common, opts.resumeSessionId, opts.prompt]
      : ["exec", ...common, "-C", opts.worktreePath, opts.prompt];
    const rename = new Map(servers.map(n => [n, "unblocked"]));
    return runSession({ ...opts, model, binary: BINARY, args, translator: translator(model, rename), keepRaw: true });
  },
};
