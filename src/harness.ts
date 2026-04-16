/**
 * Procedural agent loop.
 *
 * This is the core of the comparison tool. It runs a deterministic loop:
 *   1. Send task + tools to the model
 *   2. Model responds with text and/or tool calls
 *   3. Execute tool calls locally
 *   4. Feed results back to the model
 *   5. Repeat until the model stops calling tools or we hit maxTurns
 *
 * No LLM is involved in the loop control, metric collection, or tool
 * execution. The model only decides what tools to call and what to say.
 */

import type {
  ProviderAdapter,
  ToolDefinition,
  Message,
  ContentBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "./providers/types.js";
import { BUILTIN_TOOL_DEFINITIONS, executeBuiltinTool } from "./tools/builtin.js";
import type { McpConnection } from "./tools/mcp-client.js";

// ── ANSI ────────────────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const MAGENTA = "\x1b[35m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

// ── Types ───────────────────────────────────────────────────────────────

export interface ToolCallRecord {
  timestamp: number;
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
  isMcp: boolean;
  mcpServer?: string;
  durationMs: number;
}

export interface ModelCallRecord {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface RunResult {
  label: string;
  elapsedMs: number;
  turns: number;
  tokenUsage: { input: number; output: number };
  modelCalls: ModelCallRecord[];
  toolCalls: ToolCallRecord[];
  mcpCalls: number;
  transcript: string[];
  finalResponse: string;
}

// ── System prompt ───────────────────────────────────────────────────────

function buildSystemPrompt(repoPath: string): string {
  return `You are an engineering agent performing a task on a local codebase.

## Environment

- The repository is at: ${repoPath}
- All file paths in tool calls should be relative to the repo root.

## Rules

- Be efficient: gather context, implement, verify.
- Write clean, minimal changes. Don't refactor unrelated code.
- When done, output a final summary of changes made.`;
}

function buildResearchMessage(task: string, repoPath: string): string {
  return `## Task

${task}

## Repository

${repoPath}

Before implementing anything, review your available tools and research this task. Use any context or research tools available to understand prior work, conventions, and related discussions. Explore the codebase to understand the relevant code. Report what you found.`;
}

function buildImplementMessage(): string {
  return `Now implement the task based on what you've learned. Verify your changes when done and provide a summary.`;
}

// ── Harness ─────────────────────────────────────────────────────────────

export async function runSession(params: {
  label: string;
  provider: ProviderAdapter;
  repoPath: string;
  task: string;
  mcpConnections: McpConnection[];
  maxTurns: number;
}): Promise<RunResult> {
  const { label, provider, repoPath, task, mcpConnections, maxTurns } = params;

  const tag = label.includes("enhanced") ? MAGENTA : DIM;
  const prefix = `${tag}[${label}]${RESET}`;

  // Build the full tool set: built-ins + all MCP tools
  const allTools: ToolDefinition[] = [...BUILTIN_TOOL_DEFINITIONS];
  const mcpToolMap = new Map<string, McpConnection>();

  for (const conn of mcpConnections) {
    allTools.push(...conn.tools);
    for (const tool of conn.tools) {
      mcpToolMap.set(tool.name, conn);
    }
  }

  console.log(
    `${prefix} Starting — ${allTools.length} tools ` +
      `(${BUILTIN_TOOL_DEFINITIONS.length} built-in` +
      `${mcpConnections.length > 0 ? `, ${allTools.length - BUILTIN_TOOL_DEFINITIONS.length} MCP` : ""})`
  );

  const result: RunResult = {
    label,
    elapsedMs: 0,
    turns: 0,
    tokenUsage: { input: 0, output: 0 },
    modelCalls: [],
    toolCalls: [],
    mcpCalls: 0,
    transcript: [],
    finalResponse: "",
  };

  const messages: Message[] = [
    { role: "user", content: buildResearchMessage(task, repoPath) },
  ];

  const systemPrompt = buildSystemPrompt(repoPath);
  const startTime = Date.now();
  let turnCount = 0;
  let researchPhaseComplete = false;

  while (turnCount < maxTurns) {
    turnCount++;

    // ── Model call ──────────────────────────────────────────────────
    const modelStart = Date.now();
    let response;
    try {
      response = await provider.chat({
        system: systemPrompt,
        messages,
        tools: allTools,
      });
    } catch (err: unknown) {
      const msg = (err as Error)?.message || "Unknown error";
      console.log(`${prefix} ${RED}Model error: ${msg}${RESET}`);
      result.transcript.push(`[ERROR] Model call failed: ${msg}`);
      break;
    }
    const modelDuration = Date.now() - modelStart;

    result.modelCalls.push({
      timestamp: Date.now() - startTime,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      durationMs: modelDuration,
    });
    result.tokenUsage.input += response.usage.inputTokens;
    result.tokenUsage.output += response.usage.outputTokens;

    // ── Process response content ────────────────────────────────────
    const textBlocks = response.content.filter(
      (b): b is ContentBlock & { type: "text" } => b.type === "text"
    );
    const toolUseBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use"
    );

    // Log text output
    for (const block of textBlocks) {
      if (block.text.trim()) {
        const firstLine = block.text.split("\n")[0]?.slice(0, 120);
        console.log(`${prefix} ${firstLine}`);
        result.transcript.push(`[${((Date.now() - startTime) / 1000).toFixed(1)}s] Agent: ${block.text}`);
        result.finalResponse += block.text;
      }
    }

    // ── If no tool calls, check if research phase is done ──────────
    if (response.stopReason !== "tool_use" || toolUseBlocks.length === 0) {
      if (!researchPhaseComplete) {
        // Research phase done — transition to implementation
        researchPhaseComplete = true;
        console.log(`${prefix} ${DIM}Research phase complete — starting implementation${RESET}`);
        result.transcript.push(`[${((Date.now() - startTime) / 1000).toFixed(1)}s] === Research phase complete ===`);
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: buildImplementMessage() });
        continue;
      }

      console.log(
        `${prefix} ${GREEN}Completed${RESET} (turn ${turnCount}, ${response.stopReason})`
      );
      break;
    }

    // ── Execute tool calls ──────────────────────────────────────────
    messages.push({ role: "assistant", content: response.content });

    const toolResults: ToolResultBlock[] = [];

    for (const toolUse of toolUseBlocks) {
      const toolStart = Date.now();
      let toolResult: string;
      let isError = false;
      let isMcp = false;
      let mcpServer: string | undefined;

      const mcpConn = mcpToolMap.get(toolUse.name);

      if (mcpConn) {
        // MCP tool call
        isMcp = true;
        mcpServer = mcpConn.name;
        result.mcpCalls++;

        const query =
          (toolUse.input as { query?: string }).query ||
          JSON.stringify(toolUse.input).slice(0, 100);
        console.log(
          `${prefix} ${MAGENTA}MCP [${mcpConn.name}]${RESET} ${toolUse.name.split("__").pop()} — ${DIM}${query.slice(0, 80)}${RESET}`
        );

        try {
          toolResult = await mcpConn.callTool(toolUse.name, toolUse.input);
        } catch (err: unknown) {
          toolResult = `MCP tool error: ${(err as Error)?.message || "unknown"}`;
          isError = true;
        }
      } else {
        // Built-in tool call
        if (toolUse.name === "bash") {
          const cmd = ((toolUse.input as { command?: string }).command || "").slice(
            0,
            100
          );
          console.log(`${prefix} ${DIM}$ ${cmd}${RESET}`);
        } else {
          console.log(`${prefix} ${DIM}[${toolUse.name}]${RESET}`);
        }

        const builtinResult = executeBuiltinTool(
          toolUse.name,
          toolUse.input,
          repoPath
        );
        toolResult = builtinResult.result;
        isError = builtinResult.isError;
      }

      const toolDuration = Date.now() - toolStart;

      result.toolCalls.push({
        timestamp: Date.now() - startTime,
        name: toolUse.name,
        input: toolUse.input,
        result: toolResult.slice(0, 500),
        isError,
        isMcp,
        mcpServer,
        durationMs: toolDuration,
      });

      result.transcript.push(
        `[${((Date.now() - startTime) / 1000).toFixed(1)}s] Tool: ${toolUse.name}` +
          (isMcp ? ` [MCP: ${mcpServer}]` : "")
      );

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: toolResult,
        is_error: isError,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  if (turnCount >= maxTurns) {
    console.log(`${prefix} ${RED}Reached max turns (${maxTurns})${RESET}`);
  }

  result.elapsedMs = Date.now() - startTime;
  result.turns = turnCount;

  console.log(
    `${prefix} ${DIM}${(result.elapsedMs / 1000).toFixed(0)}s | ` +
      `${result.tokenUsage.input.toLocaleString()} in / ${result.tokenUsage.output.toLocaleString()} out | ` +
      `${result.toolCalls.length} tool calls` +
      (result.mcpCalls > 0 ? ` (${result.mcpCalls} MCP)` : "") +
      RESET
  );

  return result;
}
