/**
 * OpenAI provider adapter.
 *
 * Translates our normalized tool-use interface into OpenAI's
 * Chat Completions API format and back.
 */

import OpenAI from "openai";
import type {
  ProviderAdapter,
  ModelResponse,
  Message,
  ToolDefinition,
  ContentBlock,
} from "./types.js";

export class OpenAIAdapter implements ProviderAdapter {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async chat(params: {
    system: string;
    messages: Message[];
    tools: ToolDefinition[];
  }): Promise<ModelResponse> {
    // Build OpenAI messages
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: params.system },
    ];

    for (const m of params.messages) {
      if (m.role === "user") {
        if (typeof m.content === "string") {
          messages.push({ role: "user", content: m.content });
        } else {
          // Tool results — OpenAI expects separate tool messages
          for (const tr of m.content) {
            messages.push({
              role: "tool",
              tool_call_id: tr.tool_use_id,
              content: tr.content,
            });
          }
        }
      } else {
        // Assistant message — may contain text and tool calls
        const textParts = m.content.filter((b) => b.type === "text");
        const toolParts = m.content.filter((b) => b.type === "tool_use");

        const msg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: textParts.map((b) => b.text).join("\n") || null,
        };

        if (toolParts.length > 0) {
          msg.tool_calls = toolParts.map((b) => ({
            id: b.id,
            type: "function" as const,
            function: {
              name: b.name,
              arguments: JSON.stringify(b.input),
            },
          }));
        }

        messages.push(msg);
      }
    }

    // Build tools
    const tools: OpenAI.ChatCompletionTool[] = params.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: 16384,
      messages,
      tools: tools.length > 0 ? tools : undefined,
    });

    const choice = response.choices[0];
    const content: ContentBlock[] = [];

    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
    }

    const stopReason =
      choice.finish_reason === "tool_calls"
        ? "tool_use"
        : choice.finish_reason === "length"
          ? "max_tokens"
          : "end_turn";

    return {
      content,
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
      },
      stopReason,
    };
  }
}
