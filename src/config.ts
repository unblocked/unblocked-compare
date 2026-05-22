/**
 * Configuration types and loader for unblocked-compare.
 *
 * The config file defines: which model to use, the task, the repo,
 * and which MCP servers each run gets.
 */

import { readFileSync, existsSync } from "fs";

// ── MCP server configuration ───────────────────────────────────────────

export interface McpServerConfig {
  /** Transport type */
  type: "sse" | "stdio";

  /** SSE: URL of the MCP SSE endpoint */
  url?: string;

  /** SSE: additional headers (e.g. Authorization) */
  headers?: Record<string, string>;

  /** stdio: command to spawn */
  command?: string;

  /** stdio: arguments to the command */
  args?: string[];

  /** stdio: environment variables for the child process */
  env?: Record<string, string>;
}

// ── Run configuration ──────────────────────────────────────────────────

export interface RunConfig {
  /** MCP servers available to this run (key = display name) */
  mcpServers?: Record<string, McpServerConfig>;
}

// ── Judge configuration ────────────────────────────────────────────────

export interface JudgeConfig {
  /** Provider for the judge call. Defaults to same as main provider. */
  provider?: "anthropic" | "openai";

  /** Model for the judge call. Defaults to a strong model for the provider. */
  model?: string;

  /** API key for the judge. Defaults to same as main API key. */
  apiKey?: string;
}

// ── Top-level config ───────────────────────────────────────────────────

export interface CompareConfig {
  /** Model provider: "anthropic" or "openai" */
  provider: "anthropic" | "openai";

  /** Model identifier (e.g. "claude-sonnet-4-6", "gpt-4o") */
  model: string;

  /** API key for the model provider */
  apiKey: string;

  /** Base URL override for the provider API endpoint */
  baseURL?: string;

  /** Path to the local repo to work on */
  repo: string;

  /** Task description for the agent */
  task: string;

  /** Unblocked API token */
  unblockedToken: string;

  /**
   * Run A: baseline.
   * Model + built-in tools + any MCPs the customer brings.
   */
  baseline: RunConfig;

  /**
   * Run B: enhanced.
   * Model + built-in tools + Unblocked MCP + any additional MCPs.
   */
  enhanced: RunConfig;

  /** Max tool-call turns before forcing the agent to stop. Default: 50 */
  maxTurns?: number;

  /** LLM-as-judge configuration. */
  judge?: JudgeConfig;
}

// ── Loader ─────────────────────────────────────────────────────────────

export function loadConfig(path: string): CompareConfig {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }

  const raw = JSON.parse(readFileSync(path, "utf-8"));

  // Resolve API keys from env based on provider
  if (!raw.apiKey) {
    const keyMap: Record<string, string | undefined> = {
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,


    };
    raw.apiKey = keyMap[raw.provider];
  }
  if (!raw.unblockedToken) {
    raw.unblockedToken =
      process.env.UNBLOCKED_API_TOKEN || process.env.UNBLOCKED_MCP_TOKEN;
  }

  // Defaults
  raw.baseline = raw.baseline || {};
  raw.enhanced = raw.enhanced || {};
  raw.maxTurns = raw.maxTurns || 50;

  // Validate required fields
  const required: (keyof CompareConfig)[] = [
    "provider",
    "model",
    "apiKey",
    "repo",
    "task",
    "unblockedToken",
  ];
  for (const field of required) {
    if (!raw[field]) {
      throw new Error(
        `Missing required config field: "${field}". ` +
          `Set it in the config file or the corresponding env var.`
      );
    }
  }

  const validProviders = ["anthropic", "openai"];
  if (!validProviders.includes(raw.provider)) {
    throw new Error(
      `Unsupported provider: "${raw.provider}". Use one of: ${validProviders.join(", ")}`
    );
  }

  return raw as CompareConfig;
}
