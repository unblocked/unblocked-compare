/**
 * Normalized interfaces for model providers.
 *
 * Every provider adapter translates its native API into these types
 * so the harness works identically regardless of provider.
 */

// ── Tool definition (passed to the model) ──────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── Content blocks (normalized model response) ─────────────────────────

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolUseBlock;

// ── Tool result (fed back to the model) ────────────────────────────────

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// ── Messages ───────────────────────────────────────────────────────────

export interface UserMessage {
  role: "user";
  content: string | ToolResultBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
}

export type Message = UserMessage | AssistantMessage;

// ── Model response ─────────────────────────────────────────────────────

export interface ModelResponse {
  content: ContentBlock[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

// ── Provider adapter interface ─────────────────────────────────────────

export interface ProviderAdapter {
  chat(params: {
    system: string;
    messages: Message[];
    tools: ToolDefinition[];
  }): Promise<ModelResponse>;
}
