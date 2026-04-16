# unblocked-compare

Local A/B comparison tool that measures what Unblocked adds to your existing LLM workflow.

You bring your model API key and your existing MCP tools. The tool runs the same task twice -- once with your current setup, once with Unblocked -- and produces a structured comparison of quality, cost, and time.

## How it works

1. **Run A (Baseline):** Your model + built-in coding tools + your MCP servers (Glean, Sourcegraph, etc.)
2. **Run B (Enhanced):** Same model + same tools + Unblocked MCP (+ any additional MCPs you need)
3. **Report:** Deterministic metrics (tokens, cost, time) + a single blinded LLM-as-judge evaluation

Everything is procedural. The only LLM calls are the agent performing the task and a single judge call at the end. No LLM in the loop control, metric collection, or test setup.

## Setup

Install [Bun](https://bun.sh) if you don't have it:

```bash
curl -fsSL https://bun.sh/install | bash
```

Clone and install:

```bash
git clone https://github.com/unblocked-web/unblocked-compare.git
cd unblocked-compare
bun install
```

Create `.env.local` with your API keys:

```bash
cp .env.local.example .env.local
```

Edit `.env.local` and fill in the key for your provider plus the Unblocked token:

```
# Set the one that matches your --provider flag
ANTHROPIC_API_KEY=             # --provider anthropic
OPENAI_API_KEY=                # --provider openai

# Always required
UNBLOCKED_API_TOKEN=
```

You only need one provider key -- whichever matches the `--provider` flag you use. Bun automatically loads `.env.local` at runtime.

Get your Unblocked API token from your account at [getunblocked.com](https://getunblocked.com), or ask your Unblocked contact for a trial token.

That's it for setup. You only do this once.

## Running a comparison

Point the tool at any local repository and give it a task:

```bash
bun run compare \
  --provider anthropic \
  --model claude-sonnet-4-6 \
  --repo /path/to/your/app \
  --task "Add rate limiting to the /api/webhooks endpoint"
```

The `--repo` flag is a path to any git repository on your machine -- this is the codebase the agent will read, edit, and run tests against. The comparison harness stays in `unblocked-compare/`; your application repo is where the actual work happens.

Results are written to a timestamped directory under `results/`.

### CLI options

| Flag | Short | Description |
|---|---|---|
| `--provider` | `-p` | Model provider: `anthropic` or `openai` |
| `--model` | `-m` | Model identifier (e.g. `claude-sonnet-4-6`, `gpt-4o`) |
| `--repo` | `-r` | Path to the local repository to work on |
| `--task` | `-t` | Engineering task for the agent to perform |
| `--max-turns` | | Max tool-call turns per session (default: 50) |
| `--config` | `-c` | Path to a JSON config file (for advanced use with MCPs) |
| `--help` | `-h` | Show help |

## Bringing your own MCP servers

When you want to compare Unblocked against another context tool (Glean, Sourcegraph, etc.) or include internal MCP servers, use a config file:

```bash
bun run compare --config compare.json
```

### Config file structure

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "repo": "/path/to/your/app",
  "task": "Add rate limiting to the /api/webhooks endpoint",
  "baseline": {
    "mcpServers": {
      "glean": {
        "type": "sse",
        "url": "https://acme.glean.com/mcp",
        "headers": { "Authorization": "Bearer glean_token_here" }
      }
    }
  },
  "enhanced": {},
  "maxTurns": 30
}
```

API keys are always read from `.env.local` -- they do not go in the config file.

The config file is only needed when you are bringing MCP servers. For simple comparisons (no MCPs in the baseline), use CLI flags directly.

### MCP server types

| Type | Required fields | Use case |
|---|---|---|
| `sse` | `url` | Cloud-hosted MCP servers (Glean, Unblocked, custom HTTP servers) |
| `stdio` | `command` | Locally-installed MCP servers (Sourcegraph CLI, custom tools) |

Optional fields for `sse`: `headers` (object of HTTP headers, e.g. for auth tokens).

Optional fields for `stdio`: `args` (array of CLI arguments), `env` (object of environment variables).

Both runs support any number of MCP servers. Run B automatically includes Unblocked.

### Example: Glean vs Unblocked

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "repo": "/path/to/your/app",
  "task": "Add retry logic to the payment service webhook handler",
  "baseline": {
    "mcpServers": {
      "glean": {
        "type": "sse",
        "url": "https://acme.glean.com/mcp",
        "headers": { "Authorization": "Bearer glean_token_here" }
      }
    }
  },
  "enhanced": {},
  "maxTurns": 40
}
```

Run A gets the model + Glean. Run B gets the model + Unblocked. The report shows which context source produces better results.

### Example: local Sourcegraph MCP server

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "repo": "/path/to/your/app",
  "task": "Refactor the user service to use the new auth middleware",
  "baseline": {
    "mcpServers": {
      "sourcegraph": {
        "type": "stdio",
        "command": "sourcegraph-mcp-server",
        "args": ["--endpoint", "https://sourcegraph.internal.com"],
        "env": { "SRC_ACCESS_TOKEN": "sgp_your_token" }
      }
    }
  },
  "enhanced": {},
  "maxTurns": 30
}
```

### Adding MCPs to the enhanced run

Enterprise customers may need internal MCP servers in both runs (e.g. an internal deployment tool). Add them under `enhanced.mcpServers` -- Unblocked is always included automatically:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "repo": "/path/to/your/app",
  "task": "Deploy the hotfix to staging",
  "baseline": {
    "mcpServers": {
      "deploy-tool": {
        "type": "sse",
        "url": "https://deploy.internal.com/mcp",
        "headers": { "Authorization": "Bearer deploy_token" }
      }
    }
  },
  "enhanced": {
    "mcpServers": {
      "deploy-tool": {
        "type": "sse",
        "url": "https://deploy.internal.com/mcp",
        "headers": { "Authorization": "Bearer deploy_token" }
      }
    }
  },
  "maxTurns": 30
}
```

## Output

Each run produces a timestamped directory under `results/`:

```
results/2026-04-15T14-30-00/
  comparison.md       # Side-by-side metrics table + judge analysis
  comparison.json     # Machine-readable metrics (for aggregation across runs)
  baseline.md         # Full session transcript for Run A
  enhanced.md         # Full session transcript for Run B
```

### Metrics captured

| Metric | How it is measured |
|---|---|
| Wall-clock time | `Date.now()` delta in the harness |
| Input/output tokens | From model API response metadata (exact) |
| Estimated cost | Tokens x published per-token rate (computed) |
| Tool call count | Counter in the harness loop (exact) |
| MCP query count | Counter on MCP-routed tool calls (exact) |
| Quality scores (1-10) | LLM-as-judge, blinded and position-randomized |

### Judge evaluation

The judge is a single LLM call at the end. It receives both session transcripts with labels randomized (Session A/B, not Baseline/Enhanced) and scores each on:

1. **Understanding** -- Did the agent correctly understand the context and intent?
2. **Implementation** -- Were the changes appropriate and pattern-consistent?
3. **Context awareness** -- Did the agent discover relevant prior work or decisions?
4. **Risk awareness** -- Did the agent flag risks or related ongoing work?
5. **Efficiency** -- Time and token usage relative to output quality.

Scores are 1-10 per dimension, totaled out of 50. The judge can use a different model than the agent runs -- configure this with the `judge` field in the config file.

## How it stays fair

- **Same model, same harness, same tools.** Both runs use the identical provider instance, system prompt, and built-in tools. The only variable is which MCP servers are connected.
- **Repo reset between runs.** If the target is a git repository, the working tree is reset to a clean state between Run A and Run B so both start from identical code.
- **Blinded evaluation.** The judge does not know which session had Unblocked. Session order is randomized to eliminate position bias.
- **Procedural metrics.** Token counts, timing, and costs are computed from API response metadata and published pricing. No estimation or LLM involvement.

## Supported providers and models

Any model that supports tool use through these providers:

| Provider | `--provider` | Env var | Example models |
|---|---|---|---|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5-20251001 |
| OpenAI | `openai` | `OPENAI_API_KEY` | gpt-4o, gpt-4o-mini, gpt-4.1, gpt-4.1-mini, o3, o3-mini, o4-mini |

Cost estimation requires the model to be listed in the pricing table in `src/costs.ts`. Unlisted models still work -- cost is reported as unknown.

## Config file reference

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `provider` | `"anthropic"` or `"openai"` | Yes | -- | Model API provider |
| `model` | string | Yes | -- | Model identifier |
| `repo` | string | Yes | -- | Path to local repository |
| `task` | string | Yes | -- | Task description for the agent |
| `baseline` | object | No | `{}` | Baseline run config |
| `baseline.mcpServers` | object | No | `{}` | Named MCP server configs for Run A |
| `enhanced` | object | No | `{}` | Enhanced run config |
| `enhanced.mcpServers` | object | No | `{}` | Additional MCP server configs for Run B |
| `maxTurns` | number | No | `50` | Max tool-call turns per session |
| `judge` | object | No | same as main | Judge LLM config |
| `judge.provider` | string | No | same as main | Judge model provider |
| `judge.model` | string | No | same as main | Judge model identifier |

## Troubleshooting

**"Missing required config field: apiKey"** -- Your `.env.local` file is missing or doesn't have the right key set. Make sure `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set in `.env.local`.

**"Missing required config field: unblockedToken"** -- Set `UNBLOCKED_API_TOKEN` in `.env.local`.

**"Failed to connect to Unblocked MCP"** -- Check that your Unblocked token in `.env.local` is valid and not expired.

**MCP server connection failure** -- Check the server URL/command, auth headers, and that the server is reachable from your machine. The error message will name which server failed.

**"Command failed with exit code ..."** -- A shell command run by the agent failed. Check the baseline/enhanced transcript files for the full command and output.

**JSON parse error in config file** -- Config files must be valid JSON. Do not include `//` comments.
