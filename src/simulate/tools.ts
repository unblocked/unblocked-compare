// Tool-call recording for the simulator's reports. Each step's stdout is fed
// through the compare tool's canonical transcript (Claude Code stream-json),
// translating Cursor and Codex events on the way, so both tools count and
// label tool calls the same way.
import { parseStreamJson } from "../transcript.ts";
import { translator as cursorTranslator } from "../agents/cursor.ts";
import { translator as codexTranslator } from "../agents/codex.ts";
import type { Translator } from "../agents/session.ts";
import { toolCategory, toolLabel } from "../report.ts";

export interface SimToolCall {
  name: string;
  // "Bash", "Read", "Unblocked", "MCP:<server>", ... as in the compare report.
  category: string;
  label: string;
  isMcp: boolean;
  mcpServer?: string;
  // MCP calls: the query or URL the agent asked for.
  query?: string;
  durationMs?: number;
  // Epoch ms, for the union of tool spans (parallel calls counted once).
  startedAt?: number;
}

export type RecordedAgent = "claude" | "cursor" | "codex";

export class ToolRecorder {
  private lines: string[] = [];
  private translator: Translator | null;

  constructor(agent: RecordedAgent) {
    this.translator = agent === "cursor" ? cursorTranslator(new Map())
      : agent === "codex" ? codexTranslator(undefined, new Map())
      : null;
  }

  feed(line: string): void {
    if (!line.trim()) return;
    if (!this.translator) { this.lines.push(line); return; }
    for (const e of this.translator.translate(line, Date.now())) this.lines.push(JSON.stringify(e));
  }

  // Model responses in the transcript (for Cursor, one per model_call_id).
  messages(): number {
    return parseStreamJson(this.lines.join("\n"), null, true).assistantTurns;
  }

  calls(): SimToolCall[] {
    return parseStreamJson(this.lines.join("\n"), null, true).toolCalls.map(tc => {
      const q = tc.args.query ?? tc.args.url ?? tc.args.urls;
      return {
        name: tc.name,
        category: toolCategory(tc),
        label: toolLabel(tc),
        isMcp: tc.isMcp,
        ...(tc.mcpServer ? { mcpServer: tc.mcpServer } : {}),
        ...(tc.isMcp && q ? { query: String(Array.isArray(q) ? q.join(" ") : q).slice(0, 300) } : {}),
        ...(tc.durationMs !== undefined ? { durationMs: tc.durationMs } : {}),
        ...(tc.timestamp > 0 ? { startedAt: tc.timestamp } : {}),
      };
    });
  }
}
