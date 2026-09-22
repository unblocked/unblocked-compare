import type { Agent } from "./types.ts";
import { identity, runSession } from "./session.ts";

const BINARY = process.env.CLAUDE_BINARY ?? "claude";

const UNBLOCKED_MCP_TOOLS = [
  "mcp__unblocked__context_research",
  "mcp__unblocked__context_get_urls",
  "mcp__unblocked__context_get_rules",
  "mcp__unblocked__submit_feedback",
];

export const claude: Agent = {
  name: "claude",
  label: "Claude Code",
  defaultModel: "opus",
  cacheWriteTier: "1h",

  // Blocking is per invocation (--disallowed-tools), so the worktree needs nothing.
  prepareWorktree() {},

  run(opts) {
    const args = [
      "-p", opts.prompt,
      ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
      ...(opts.model ? ["--model", opts.model] : []),
    ];
    // CLI mode keeps the MCP server away from both arms.
    if (opts.blockUnblocked || opts.cliMode) {
      for (const tool of UNBLOCKED_MCP_TOOLS) args.push("--disallowed-tools", tool);
    }
    if (opts.blockUnblocked) args.push("--disallowed-tools", "Bash(unblocked *)");
    return runSession({ ...opts, binary: BINARY, args, translator: identity(), keepRaw: false });
  },
};
