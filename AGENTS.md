# unblocked-compare

Local A/B comparison tool. Runs the same task twice against a customer's repo — once with their current setup, once with Unblocked — and produces a structured comparison.

## How to run a comparison

Keys must be in `.env.local` (never in CLI flags, never in config files):

```
# Set the one that matches --provider
ANTHROPIC_API_KEY=...           # --provider anthropic
OPENAI_API_KEY=...              # --provider openai

# Always required
UNBLOCKED_API_TOKEN=...
```

Then run with CLI flags — no config file needed:

```bash
bun run compare \
  --provider anthropic \
  --model claude-sonnet-4-6 \
  --repo /path/to/target/repo \
  --task "Description of the engineering task"
```

Supported providers: `anthropic`, `openai`.

The `--repo` flag points to the repository the agent works on. It is not this repo — it is the customer's application repo.

## When to use a config file

Only use `--config compare.json` when bringing MCP servers (Glean, Sourcegraph, etc.) to the baseline run. For simple comparisons, CLI flags are sufficient.

## Key files

- `src/cli.ts` — CLI entry point
- `src/harness.ts` — procedural agent loop (the core)
- `src/compare.ts` — orchestrates baseline vs enhanced runs
- `src/providers/` — model API adapters (Anthropic, OpenAI)
- `src/tools/builtin.ts` — local tools (bash, read, write, edit, grep)
- `src/tools/mcp-client.ts` — generic MCP client for arbitrary servers
- `src/costs.ts` — deterministic cost calculation from token counts
- `src/judge.ts` — single blinded LLM-as-judge call (only non-procedural step)
