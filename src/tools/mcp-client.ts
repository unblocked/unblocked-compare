/**
 * Generic MCP client that connects to any MCP server (SSE or stdio),
 * discovers available tools, and proxies tool calls.
 *
 * This is the key abstraction that lets customers bring arbitrary
 * MCP servers (Glean, Sourcegraph, internal tools, Unblocked, etc.)
 * and have them work uniformly in the comparison harness.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "../config.js";
import type { ToolDefinition } from "../providers/types.js";

export interface McpConnection {
  /** Display name for this MCP server */
  name: string;

  /** The tool definitions exposed by this server (for passing to the model) */
  tools: ToolDefinition[];

  /** Call a tool on this server and return the result text */
  callTool(name: string, input: Record<string, unknown>): Promise<string>;

  /** Clean up the connection */
  close(): Promise<void>;
}

/**
 * Connect to an MCP server and discover its tools.
 *
 * @param displayName - Human-readable name (used as tool name prefix)
 * @param config - Server transport configuration
 * @returns A connected McpConnection
 */
export async function connectMcpServer(
  displayName: string,
  config: McpServerConfig
): Promise<McpConnection> {
  const client = new Client(
    { name: "unblocked-compare", version: "0.1.0" },
    { capabilities: {} }
  );

  // Create transport based on config type
  if (config.type === "sse") {
    if (!config.url) throw new Error(`SSE MCP server "${displayName}" requires a url`);
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: {
        headers: config.headers || {},
      },
    });
    await client.connect(transport);
  } else if (config.type === "stdio") {
    if (!config.command)
      throw new Error(`stdio MCP server "${displayName}" requires a command`);
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
    });
    await client.connect(transport);
  } else {
    throw new Error(`Unknown MCP transport type for "${displayName}"`);
  }

  // Discover tools
  const toolsResult = await client.listTools();
  const prefix = sanitizePrefix(displayName);

  const tools: ToolDefinition[] = (toolsResult.tools || []).map((t) => ({
    // Prefix tool names to avoid collisions between MCP servers
    name: `${prefix}__${t.name}`,
    description: `[${displayName}] ${t.description || t.name}`,
    inputSchema: (t.inputSchema as Record<string, unknown>) || {
      type: "object",
      properties: {},
    },
  }));

  return {
    name: displayName,
    tools,

    async callTool(
      toolName: string,
      input: Record<string, unknown>
    ): Promise<string> {
      // Strip our prefix to get the original tool name
      const originalName = toolName.startsWith(`${prefix}__`)
        ? toolName.slice(prefix.length + 2)
        : toolName;

      const result = await client.callTool({
        name: originalName,
        arguments: input,
      });

      // Extract text content from the result
      if (result.content && Array.isArray(result.content)) {
        return result.content
          .map((c: { type?: string; text?: string }) =>
            c.type === "text" ? c.text || "" : JSON.stringify(c)
          )
          .join("\n");
      }

      return JSON.stringify(result);
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}

/**
 * Build the Unblocked MCP server config from a token.
 */
export function buildUnblockedConfig(token: string): McpServerConfig {
  return {
    type: "sse",
    url: "https://getunblocked.com/api/mcpsse",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}

function sanitizePrefix(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "_");
}
