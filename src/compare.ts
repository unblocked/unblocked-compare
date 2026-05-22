/**
 * Comparison orchestrator.
 *
 * Wires everything together:
 *  1. Connect to all MCP servers
 *  2. Run baseline session (customer's MCPs)
 *  3. Run enhanced session (Unblocked + optional MCPs)
 *  4. Compute deterministic metrics
 *  5. Run LLM-as-judge
 *  6. Write reports
 */

import { resolve } from "path";
import type { CompareConfig } from "./config.js";
import type { ProviderAdapter } from "./providers/types.js";
import { AnthropicAdapter } from "./providers/anthropic.js";
import { OpenAIAdapter } from "./providers/openai.js";
import {
  connectMcpServer,
  buildUnblockedConfig,
  type McpConnection,
} from "./tools/mcp-client.js";
import { runSession, type RunResult } from "./harness.js";
import { judgeComparison } from "./judge.js";
import { writeComparisonReport } from "./report.js";

// ── ANSI ────────────────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

function createProvider(
  provider: string,
  apiKey: string,
  model: string,
  baseURL?: string
): ProviderAdapter {
  switch (provider) {
    case "anthropic":
      return new AnthropicAdapter(apiKey, model, baseURL);
    case "openai":
      return new OpenAIAdapter(apiKey, model, baseURL);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

export async function runComparison(config: CompareConfig): Promise<void> {
  const repoPath = resolve(config.repo);

  console.log(`${BOLD}unblocked-compare${RESET}\n`);
  console.log(`${BOLD}provider:${RESET}  ${config.provider}`);
  console.log(`${BOLD}model:${RESET}     ${config.model}`);
  if (config.baseURL) {
    console.log(`${BOLD}base URL:${RESET}  ${config.baseURL}`);
  }
  console.log(`${BOLD}repo:${RESET}      ${repoPath}`);
  console.log(`${BOLD}task:${RESET}      ${config.task}`);
  console.log(`${BOLD}max turns:${RESET} ${config.maxTurns}`);
  console.log();

  // Create the model provider (same instance for both runs = same model, same key)
  const provider = createProvider(config.provider, config.apiKey, config.model, config.baseURL);

  // ── Connect to MCP servers ────────────────────────────────────────
  const baselineMcpConnections: McpConnection[] = [];
  const enhancedMcpConnections: McpConnection[] = [];

  // Baseline MCPs (customer's existing tools)
  if (config.baseline.mcpServers) {
    console.log(`${BLUE}Connecting baseline MCPs...${RESET}`);
    for (const [name, serverConfig] of Object.entries(config.baseline.mcpServers)) {
      try {
        console.log(`  ${DIM}${name}: ${serverConfig.type} ${serverConfig.url || serverConfig.command}${RESET}`);
        const conn = await connectMcpServer(name, serverConfig);
        baselineMcpConnections.push(conn);
        console.log(`  ${GREEN}${name}: ${conn.tools.length} tools${RESET}`);
      } catch (err: unknown) {
        console.log(`  ${RED}${name}: failed — ${(err as Error)?.message}${RESET}`);
      }
    }
  }

  // Enhanced MCPs: Unblocked + any additional
  console.log(`${MAGENTA}Connecting enhanced MCPs...${RESET}`);
  try {
    console.log(`  ${DIM}unblocked: sse https://getunblocked.com/api/mcpsse${RESET}`);
    const unblockedConn = await connectMcpServer(
      "unblocked",
      buildUnblockedConfig(config.unblockedToken)
    );
    enhancedMcpConnections.push(unblockedConn);
    console.log(`  ${GREEN}unblocked: ${unblockedConn.tools.length} tools${RESET}`);
  } catch (err: unknown) {
    console.error(
      `${RED}Failed to connect to Unblocked MCP: ${(err as Error)?.message}${RESET}`
    );
    console.error("Check your UNBLOCKED_API_TOKEN and try again.");
    process.exit(1);
  }

  if (config.enhanced.mcpServers) {
    for (const [name, serverConfig] of Object.entries(config.enhanced.mcpServers)) {
      try {
        console.log(`  ${DIM}${name}: ${serverConfig.type} ${serverConfig.url || serverConfig.command}${RESET}`);
        const conn = await connectMcpServer(name, serverConfig);
        enhancedMcpConnections.push(conn);
        console.log(`  ${GREEN}${name}: ${conn.tools.length} tools${RESET}`);
      } catch (err: unknown) {
        console.log(`  ${RED}${name}: failed — ${(err as Error)?.message}${RESET}`);
      }
    }
  }

  console.log();
  console.log(
    `Running: ${BLUE}baseline${RESET} vs ${MAGENTA}enhanced (Unblocked)${RESET}\n`
  );

  // ── Run sessions sequentially ─────────────────────────────────────
  // Sequential to avoid interference (both work on the same local repo).
  // We reset the repo between runs to ensure identical starting state.

  // Capture the initial git state
  let gitResetCmd: string | undefined;
  try {
    const { execSync } = await import("child_process");
    const head = execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
    gitResetCmd = `git checkout . && git clean -fd`;
    console.log(`${DIM}Git HEAD: ${head.slice(0, 8)} (will reset between runs)${RESET}\n`);
  } catch {
    console.log(`${DIM}Not a git repo — skipping reset between runs${RESET}\n`);
  }

  // ── Run A: Baseline ───────────────────────────────────────────────
  console.log(`${"=".repeat(60)}`);
  console.log(`${BLUE}${BOLD} RUN A: BASELINE${RESET}`);
  console.log(`${"=".repeat(60)}\n`);

  const baseline = await runSession({
    label: "baseline",
    provider,
    repoPath,
    task: config.task,
    mcpConnections: baselineMcpConnections,
    maxTurns: config.maxTurns || 50,
  });

  // Reset repo between runs
  if (gitResetCmd) {
    console.log(`\n${DIM}Resetting repo to clean state...${RESET}`);
    const { execSync } = await import("child_process");
    execSync(gitResetCmd, { cwd: repoPath, stdio: "ignore" });
  }

  console.log();

  // ── Run B: Enhanced ───────────────────────────────────────────────
  console.log(`${"=".repeat(60)}`);
  console.log(`${MAGENTA}${BOLD} RUN B: ENHANCED (UNBLOCKED)${RESET}`);
  console.log(`${"=".repeat(60)}\n`);

  const enhanced = await runSession({
    label: "enhanced",
    provider,
    repoPath,
    task: config.task,
    mcpConnections: enhancedMcpConnections,
    maxTurns: config.maxTurns || 50,
  });

  // Reset repo after runs
  if (gitResetCmd) {
    const { execSync } = await import("child_process");
    execSync(gitResetCmd, { cwd: repoPath, stdio: "ignore" });
  }

  console.log();

  // ── Judge ─────────────────────────────────────────────────────────
  console.log(`${"=".repeat(60)}`);
  console.log(`${BOLD} JUDGE ANALYSIS${RESET}`);
  console.log(`${"=".repeat(60)}\n`);

  console.log(`${DIM}Running blinded LLM-as-judge evaluation...${RESET}\n`);

  // Use a separate provider for the judge if configured
  const judgeProvider = config.judge?.provider
    ? createProvider(
        config.judge.provider,
        config.judge.apiKey || config.apiKey,
        config.judge.model || config.model
      )
    : provider;

  const judgeResult = await judgeComparison(
    judgeProvider,
    config.task,
    repoPath,
    baseline,
    enhanced
  );

  console.log(judgeResult.analysis);

  // ── Report ────────────────────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputDir = resolve("results", timestamp);

  const files = writeComparisonReport({
    outputDir,
    task: config.task,
    repoPath,
    model: config.model,
    baseline,
    enhanced,
    judgeResult,
  });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`${GREEN}${BOLD} REPORTS${RESET}`);
  console.log(`${"=".repeat(60)}\n`);
  console.log(`  ${files.comparisonFile}`);
  console.log(`  ${files.baselineFile}`);
  console.log(`  ${files.enhancedFile}`);
  console.log(`  comparison.json`);
  console.log(`\n  ${DIM}${outputDir}${RESET}`);

  // ── Cleanup MCP connections ───────────────────────────────────────
  for (const conn of [...baselineMcpConnections, ...enhancedMcpConnections]) {
    try {
      await conn.close();
    } catch {
      // best effort
    }
  }

  console.log();
}
