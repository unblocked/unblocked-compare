# claude-harness

A/B comparison harness for Claude Code: runs the same coding task twice — once without [Unblocked](https://getunblocked.com) context (baseline) and once with — then produces structured comparison reports.

## How it works

1. Creates two isolated git worktrees from the same branch
2. Runs Claude Code in parallel on both:
   - **Baseline**: all MCP servers and tools available *except* Unblocked (blocked via `--disallowed-tools`)
   - **Unblocked**: all MCP servers and tools available, with a nudge to call `context_research` first and throughout
   - Both arms get the same research and reporting instructions; only the tool availability differs
3. Captures diffs, token usage, cost, tool calls, and timing from both runs
4. With `--review`: extracts one requirement list from the task, checks each arm's diff against it, and resumes the arm's session for a fix pass until every requirement is met or the round cap is reached. A requirement waived on one arm's dispute is waived for both.
5. Analyses the pair:
   - **Attribution**: labels each API message as work, verification or housekeeping, so cost and time can be reported for core task work
   - **Quality judge** (blinded, arms presented in random order): requirements met, then introduced defects, then material hygiene, else a tie
   - **Context impact** (un-blinded): what the Unblocked research changed, and what drove the cost and time difference
   - **Tie-breaker**: a blinded tie goes to Unblocked only when the impact pass traces a decisive discovery to the research context; the report marks it and keeps the blinded verdict alongside
6. Generates console, JSON, and HTML reports per comparison, and a batch summary across repeats

## Requirements

- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) installed and authenticated
- [Unblocked MCP server](https://getunblocked.com) configured in Claude Code (or Unblocked CLI for `--cli` mode)

## Usage

```bash
bun start -- --repo /path/to/repo --task "implement feature X"
```

**The defaults run a batch.** `--repeat` defaults to 2, so the command above runs two full comparisons (four agent sessions, two at a time) plus the analysis passes. Pass `--repeat 1` for a single comparison. Each arm's `--timeout` (90 minutes by default) is shared by its draft and all of its fix passes. On macOS the harness runs `caffeinate` so the machine does not sleep mid-run.

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--repo <path>` | Path to target git repository | *required* |
| `--task <string>` | Task description for the agent | *required* |
| `--model <model>` | Model for the agents | `opus` |
| `--timeout <seconds>` | Max seconds per arm, shared across the draft and every fix pass | `5400` |
| `--branch <name>` | Branch to base worktrees on | current HEAD |
| `--keep-worktrees` | Don't clean up worktrees after run | `false` |
| `--cli` | Use Unblocked CLI via Bash instead of MCP | `false` |
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
│   │   ├── baseline.jsonl         # Raw stream-json: draft plus any fix passes
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
├── claude.ts       Spawn Claude Code CLI, parse stream-json (tokens, cost, time), worktree management
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

### Contamination guards

- **Baseline arm**: Unblocked MCP tools and CLI blocked via `--disallowed-tools`. If the baseline somehow calls Unblocked, the run is killed immediately.
- **Unblocked arm**: If Unblocked isn't called within 120 seconds, the run is killed (ensures the nudge prompt worked).
- A killed arm voids the comparison: no quality verdict or impact pass is run for it.

### How blocking works

The baseline arm passes separate `--disallowed-tools` flags for each Unblocked MCP tool and the Unblocked CLI pattern. The prompt is piped via stdin (not as a positional arg) to avoid the variadic `--disallowed-tools` flag consuming it.

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
