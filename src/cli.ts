/**
 * CLI entry point for unblocked-compare.
 *
 * Usage:
 *   bun run compare --config compare.json
 *   bun run compare --provider anthropic --model claude-sonnet-4-6 \
 *     --repo ./my-repo --task "Fix the auth bug"
 */

import { parseArgs } from "util";
import { existsSync } from "fs";
import { resolve } from "path";
import { loadConfig, type CompareConfig } from "./config.js";
import { runComparison } from "./compare.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: "string", short: "c" },
    provider: { type: "string", short: "p" },
    model: { type: "string", short: "m" },
    repo: { type: "string", short: "r" },
    task: { type: "string", short: "t" },
    "max-turns": { type: "string" },
    "base-url": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`
unblocked-compare — Local A/B comparison tool

Compare your LLM + toolchain against your LLM + Unblocked.

USAGE:
  bun run compare --config compare.json
  bun run compare --provider anthropic --model claude-sonnet-4-6 \\
    --repo ./my-repo --task "Fix the auth bug"

OPTIONS:
  -c, --config      Path to a JSON config file (recommended)
  -p, --provider    Model provider: "anthropic" or "openai"
  -m, --model       Model identifier (e.g. "claude-sonnet-4-6", "gpt-4o")
  -r, --repo        Path to the local repository
  -t, --task        Task description
  --max-turns       Max tool-call turns per session (default: 50)
  --base-url        Base URL override for the provider API endpoint
  -h, --help        Show this help

ENVIRONMENT VARIABLES (set in .env.local):
  ANTHROPIC_API_KEY       API key for Anthropic models
  OPENAI_API_KEY          API key for OpenAI models
  UNBLOCKED_API_TOKEN     Unblocked MCP token

CONFIG FILE:
  For full control (including custom MCPs), use a JSON config file:

  {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "repo": "./my-repo",
    "task": "Fix the authentication timeout bug",
    "baseline": {
      "mcpServers": {
        "glean": {
          "type": "sse",
          "url": "https://glean.example.com/mcp",
          "headers": { "Authorization": "Bearer glean_token" }
        }
      }
    },
    "enhanced": {
      "mcpServers": {}
    },
    "maxTurns": 30,
    "judge": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6"
    }
  }

  API keys and Unblocked tokens can be set in the config file or via
  environment variables (env vars take precedence if config fields are empty).
`);
  process.exit(0);
}

// ── Build config ───────────────────────────────────────────────────────

let config: CompareConfig;

if (values.config) {
  // Load from config file
  config = loadConfig(resolve(values.config));
} else {
  // Build from CLI args + env
  const provider = values.provider as "anthropic" | "openai" | undefined;
  if (!provider) {
    console.error(
      "Error: --provider (or --config) is required.\n" +
        "Run with --help for usage."
    );
    process.exit(1);
  }

  const model = values.model;
  if (!model) {
    console.error("Error: --model is required.");
    process.exit(1);
  }

  const repo = values.repo;
  if (!repo) {
    console.error("Error: --repo is required.");
    process.exit(1);
  }

  const task = values.task;
  if (!task) {
    console.error("Error: --task is required.");
    process.exit(1);
  }

  const envVarMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
  };
  const envVar = envVarMap[provider] || "ANTHROPIC_API_KEY";
  const apiKey = process.env[envVar];

  if (!apiKey) {
    console.error(
      `Error: ${envVar} is required in .env.local for provider "${provider}".`
    );
    process.exit(1);
  }

  const unblockedToken =
    process.env.UNBLOCKED_API_TOKEN || process.env.UNBLOCKED_MCP_TOKEN;
  if (!unblockedToken) {
    console.error(
      "Error: UNBLOCKED_API_TOKEN environment variable is required."
    );
    process.exit(1);
  }

  config = {
    provider,
    model,
    apiKey,
    repo,
    task,
    unblockedToken,
    baseline: {},
    enhanced: {},
    maxTurns: values["max-turns"] ? parseInt(values["max-turns"], 10) : 50,
    ...(values["base-url"] && { baseURL: values["base-url"] }),
  };
}

// Validate repo exists
if (!existsSync(resolve(config.repo))) {
  console.error(`Error: repository not found: ${resolve(config.repo)}`);
  process.exit(1);
}

// ── Run ────────────────────────────────────────────────────────────────

runComparison(config).catch((err) => {
  console.error("\nFailed:", err);
  process.exit(1);
});
