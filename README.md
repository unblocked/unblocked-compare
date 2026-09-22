# unblocked-compare

A/B comparison harness for coding agents: runs the same coding task twice in the agent a team already uses — once without [Unblocked](https://getunblocked.com) context (baseline) and once with — then produces structured comparison reports.

Supported agents (`--agent`):

| Agent | CLI | Default model |
|---|---|---|
| `claude` (default) | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) | `opus` |
| `cursor` | [Cursor CLI](https://cursor.com/cli) (`agent`) | Cursor's configured default |
| `codex` | [OpenAI Codex CLI](https://github.com/openai/codex) (`codex`) | `model` in `~/.codex/config.toml` |

## How it works

1. Creates two isolated git worktrees from the same branch
2. Runs the agent in parallel on both:
   - **Baseline**: all MCP servers and tools available *except* Unblocked (see [How blocking works](#how-blocking-works))
   - **Unblocked**: all MCP servers and tools available, with a nudge to call `context_research` first and throughout
   - Both arms get the same research and reporting instructions; only the tool availability differs
3. Captures diffs, token usage, cost, tool calls, and timing from both runs. Each agent's event stream is translated into one canonical transcript (Claude Code's stream-json), so every analysis below works the same for every agent
4. With `--review`: extracts one requirement list from the task, checks each arm's diff against it, and resumes the arm's session for a fix pass until every requirement is met or the round cap is reached. A requirement waived on one arm's dispute is waived for both.
5. Analyses the pair:
   - **Attribution**: labels each API message as work, verification or housekeeping, so cost and time can be reported for core task work
   - **Quality judge** (blinded, arms presented in random order): requirements met, then introduced defects, then material hygiene, else a tie
   - **Context impact** (un-blinded): what the Unblocked research changed, and what drove the cost and time difference
   - **Tie-breaker**: a blinded tie goes to Unblocked only when the impact pass traces a decisive discovery to the research context; the report marks it and keeps the blinded verdict alongside
6. Generates console, JSON, and HTML reports per comparison, and a batch summary across repeats

## Requirements

- [Bun](https://bun.sh) runtime
- The CLI of the agent under test, installed and authenticated: `claude`, `agent` (Cursor) or `codex`
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) in every case: the requirement check, attribution, quality judge and impact passes run through `claude -p` whatever agent is under test
- Unblocked configured as an MCP server in the agent under test (`~/.claude.json`, `~/.cursor/mcp.json` or `~/.codex/config.toml`), or the [Unblocked CLI](https://getunblocked.com) for `--cli` mode

## Usage

```bash
bun start -- --repo /path/to/repo --task "implement feature X"
bun start -- --agent cursor --repo /path/to/repo --task "implement feature X"
bun start -- --agent codex --model gpt-5.5 --repo /path/to/repo --task "implement feature X"
```

**The defaults run a batch.** `--repeat` defaults to 2, so the command above runs two full comparisons (four agent sessions, two at a time) plus the analysis passes. Pass `--repeat 1` for a single comparison. Each arm's `--timeout` (90 minutes by default) is shared by its draft and all of its fix passes. On macOS the harness runs `caffeinate` so the machine does not sleep mid-run.

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--repo <path>` | Path to target git repository | *required* |
| `--task <string>` | Task description for the agent | *required* |
| `--agent <name>` | Agent under test: `claude`, `cursor` or `codex` | `claude` |
| `--model <model>` | Model for the agents | `opus` for claude; the CLI's configured default otherwise |
| `--timeout <seconds>` | Max seconds per arm, shared across the draft and every fix pass | `5400` |
| `--branch <name>` | Branch to base worktrees on | current HEAD |
| `--keep-worktrees` | Don't clean up worktrees after run | `false` |
| `--cli` | Use the Unblocked CLI via the shell instead of MCP; the MCP server is then off in both arms | `false` |
| `--repeat <n>` | Full comparisons to run for this task; the batch summary aggregates them | `2` |
| `--concurrency <n>` | Comparisons to run at once | `2` |
| `--review` | Requirement check and fix rounds per arm until every task requirement is met, or the cap | `false` |
| `--max-review-rounds <n>` | Cap on check-and-fix rounds when `--review` is on | `3` |
| `--checker-model <model>` | Model for the requirement check: extracts the list, grades each requirement per round, rules on disputes | `sonnet` |
| `--judge-model <model>` | Model for the quality judge and context-impact passes | `fable` |
| `--analyst-model <model>` | Model that labels each message as work, verification or housekeeping | `opus` |
| `--no-attribution` | Skip the attribution pass (currently also skips the judge and impact passes) | attribution on |

### Environment variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_BINARY` | Override Claude CLI binary name (default: `claude`) |
| `CURSOR_BINARY` | Override Cursor CLI binary name (default: `agent`) |
| `CODEX_BINARY` | Override Codex CLI binary name (default: `codex`) |
| `CODEX_HOME` | Codex config directory, read for the default model and the Unblocked server name (default: `~/.codex`) |
| `HARNESS_DEBUG_DIR` | Directory to write the raw CLI output of every analysis call (checker, judge, analyst, impact) |

### Examples

A reviewed batch of three comparisons:

```bash
bun start -- \
  --repo ~/code/my-project \
  --task "$(cat task.txt)" \
  --branch origin/main \
  --review \
  --repeat 3
```

A single quick comparison with no review loop:

```bash
bun start -- \
  --repo ~/code/my-project \
  --task 'Add rate limiting to the /api/users endpoint following existing patterns' \
  --repeat 1 \
  --keep-worktrees
```

If the base branch is behind its upstream the harness warns at start: when the task's fix has already landed upstream, both arms find it and the comparison measures something else.

### Regenerating a report

Reports can be rebuilt from saved transcripts after a parser or report change, with no agent runs:

```bash
bun scripts/report_from_jsonl.ts <baseline.jsonl> <unblocked.jsonl> <result.json> [--attribute[=model]] [--rejudge[=model]] [--impact[=model]]
```

Tokens, cost, time and tool calls are always re-parsed from the transcripts. The task, branch, diffs, review record, analyst labels, verdict and impact are carried over from `result.json`. The flags re-run the corresponding model pass (they cost money; without them the regeneration is free). Output goes to `results/regenerated/` under the current directory. Without a `result.json`, pass `[model] [branch] [task]` instead; diffs are then unavailable.

## Output

A batch (`--repeat` 2 or more) writes to `results/batch-<timestamp>-<id>/`:

```
results/batch-2026-09-20T06-12-45-805Z-6e2d/
├── summary.html             # Verdict tally and medians across the runs
├── summary.json
├── requirements.json        # The shared requirement list (with --review)
├── run-1/
│   ├── baseline/
│   │   ├── baseline.jsonl         # Canonical transcript: draft plus any fix passes
│   │   ├── baseline.raw.jsonl     # Cursor and Codex: the CLI's own output, untranslated
│   │   ├── baseline.draft.jsonl   # With --review: the draft alone
│   │   └── baseline.fix1.jsonl    # With --review: each fix pass
│   ├── unblocked/
│   │   └── unblocked.jsonl
│   ├── result.json          # Structured comparison data
│   └── report.html          # Visual comparison report
└── run-2/
```

A single comparison (`--repeat 1`) writes the contents of one `run-N/` folder to `results/run-<timestamp>/`.

The HTML report opens automatically and includes:
- Core task work: cost, model time, tool wait and tokens with housekeeping removed, next to the raw run totals
- The blinded quality verdict with per-criterion scores and findings
- The context-impact read: what the research changed, and which terms drove the cost and time difference
- The review record: each requirement's status per round, fix-pass cost, disputes and waivers
- Tool usage, slowest tool calls, and the Unblocked queries used
- Full diffs from both arms

A run that was killed (contamination, no research call, timeout, or an API error such as a session limit) gets no verdict and is left out of the batch tally and medians.

## Architecture

```
src/
├── index.ts        CLI entry point (commander)
├── runner.ts       Orchestration: batches, parallel arms, review loop, diff capture, nudge prompts
├── agents/
│   ├── types.ts    Agent interface: per-worktree setup, run (and resume) a session
│   ├── session.ts  Shared spawn loop: stream → canonical transcript, timeout, contamination guards
│   ├── claude.ts   Claude Code adapter (its stream-json is the canonical format)
│   ├── cursor.ts   Cursor adapter and stream-json translator
│   └── codex.ts    Codex adapter and `exec --json` translator
├── transcript.ts   Canonical transcript parser (tokens, cost, tool calls, timing)
├── worktree.ts     Worktree creation and cleanup, agent branch reset
├── git.ts          Git helpers
├── review.ts       Requirement extraction, per-round check, dispute rulings and waivers
├── analyst.ts      Single-turn structured model calls, blinding of treatment names
├── attribution.ts  Per-message walk: cost, model time, tool wait, stalls; work/verify/housekeeping labels
├── quality.ts      Blinded quality judge, verification record, tie-breaker
├── impact.ts       Un-blinded context-impact pass
├── economics.ts    Cost and time breakdown between the arms
├── report.ts       Console + HTML + JSON reports, batch summary
├── util.ts         Token pricing, formatting helpers
└── types.ts        Shared type definitions
scripts/
└── report_from_jsonl.ts   Regenerate a report from saved transcripts
```

### Canonical transcript

Every analysis pass reads Claude Code's stream-json. The Cursor and Codex adapters translate as they stream:

- Tools map to Claude Code names and inputs: shell → `Bash` (`command`), file reads and edits → `Read`/`Edit`/`Write` (`file_path`), MCP → `mcp__<server>__<tool>`. Codex's `/bin/zsh -lc '…'` wrapper is unwrapped. An Unblocked MCP server configured under another name is renamed `unblocked`.
- Messages: Cursor's `model_call_id` groups one model response. Codex has no message boundaries, so a new message starts at the first model output after a tool result.
- Time: Cursor events carry timestamps. Codex events don't, so arrival time stands in.
- Tokens: Cursor and Codex report totals per session only, not per message, so per-message cost and output in the attribution are apportioned (the report marks per-message output as estimated). Codex's `input_tokens` includes cached tokens; they are split out. Neither reports cost, so cost is tokens × the list price in `src/util.ts`.

### Contamination guards

- **Baseline arm**: Unblocked MCP tools and CLI blocked via `--disallowed-tools`. If the baseline somehow calls Unblocked, the run is killed immediately.
- **Unblocked arm**: If Unblocked isn't called within 120 seconds, the run is killed (ensures the nudge prompt worked).
- A killed arm voids the comparison: no quality verdict or impact pass is run for it.

### How blocking works

- **Claude Code**: the baseline passes a separate `--disallowed-tools` flag for each Unblocked MCP tool and the `Bash(unblocked *)` pattern, so the tools are absent rather than refused.
- **Cursor**: MCP enablement is per workspace. Each arm runs in its own fresh worktree, where the harness runs `agent mcp disable <server>` (baseline) or `agent mcp enable <server>` (Unblocked arm) before the first run. The arms stay parallel and your own workspaces are untouched. Unblocked servers are found by name or URL in `~/.cursor/mcp.json` and the repo's `.cursor/mcp.json`.
- **Codex**: the baseline passes `-c mcp_servers.<server>.enabled=false` for each Unblocked server in `~/.codex/config.toml`.
- In every case the Unblocked CLI stays on the baseline's PATH. The prompt forbids it and the contamination guard kills the run if it is used.

## Tips for good comparison tasks

Tasks where Unblocked adds the most value involve **institutional knowledge** — information that lives outside the code:

- Features requiring understanding of team conventions not documented in code
- Bug fixes where root cause context is in PR discussions or issue trackers
- Implementations where prior attempts were rejected (Unblocked surfaces the why)
- Work touching systems with recent incidents or operational concerns

Tasks where Unblocked adds less value:
- Mechanical pattern-copying (e.g., "add a new model to this list")
- Pure algorithmic work with no team context needed
- Tasks where the code tells the complete story
