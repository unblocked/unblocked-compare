/**
 * Anthropic provider adapter.
 *
 * Translates our normalized tool-use interface into Anthropic's
 * Messages API format and back.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ProviderAdapter,
  ModelResponse,
  Message,
  ToolDefinition,
  ContentBlock,
} from "./types.js";

export class AnthropicAdapter implements ProviderAdapter {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(params: {
    system: string;
    messages: Message[];
    tools: ToolDefinition[];
  }): Promise<ModelResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16384,
      system: params.system,
      messages: params.messages.map((m) => {
        if (m.role === "user") {
          if (typeof m.content === "string") {
            return { role: "user" as const, content: m.content };
          }
          // Tool results
          return {
            role: "user" as const,
            content: m.content.map((tr) => ({
              type: "tool_result" as const,
              tool_use_id: tr.tool_use_id,
              content: tr.content,
              ...(tr.is_error && { is_error: true }),
            })),
          };
        }
        // Assistant message — pass content blocks through
        return {
          role: "assistant" as const,
          content: m.content.map((block) => {
            if (block.type === "text") {
              return { type: "text" as const, text: block.text };
            }
            return {
              type: "tool_use" as const,
              id: block.id,
              name: block.name,
              input: block.input,
            };
          }),
        };
      }),
      tools: params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
      })),
    });

    const content: ContentBlock[] = response.content.map((block) => {
      if (block.type === "text") {
        return { type: "text", text: block.text };
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      }
      // Fallback for thinking blocks etc — treat as text
      return { type: "text", text: "" };
    });

    const stopReason =
      response.stop_reason === "tool_use"
        ? "tool_use"
        : response.stop_reason === "max_tokens"
          ? "max_tokens"
          : "end_turn";

    return {
      content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      stopReason,
    };
  }
}
