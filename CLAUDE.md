# unblocked-compare

Two tools for measuring what Unblocked adds to a coding agent:

- `bun run compare` (`src/`) — A/B: run a task in a coding agent (Claude Code, Cursor or Codex) with and without the Unblocked tools, then compare results.
- `bun run simulate` (`src/simulate/`) — context engine simulator: a baseline arm plans and implements from the task alone; a context arm first gathers a context briefing from the codebase and MCP sources. Both are scored against acceptance criteria. Agents: Claude Code, Codex, Cursor, Grok.

The two are separate tools: `src/simulate/` has its own agent invokers, prompts and reports and shares only the price table (`src/util.ts`). The sections below cover `compare`, except the `src/simulate/` entry under Architecture; the README's "Context engine simulator" section covers `simulate`.

## Running

```bash
bun start -- --repo /path/to/repo --task "implement feature X"                  # Claude Code
bun start -- --agent cursor --repo /path/to/repo --task "implement feature X"
bun start -- --agent codex --model gpt-5.5 --repo /path/to/repo --task "implement feature X"
```

`--repo` is the customer's application repository, not this one. Defaults to a batch of 2 comparisons (`--repeat 2`); pass `--repeat 1` for one. `--review` adds the requirement check and fix loop. See README for all flags.

The analysis passes (checker, analyst, judge, impact) always run through `claude -p`, whatever agent is under test.

Binary overrides: `CLAUDE_BINARY` (default `claude`), `CURSOR_BINARY` (default `agent`), `CODEX_BINARY` (default `codex`).

## Architecture

- `src/index.ts` — CLI flags and defaults
- `src/runner.ts` — Orchestrate: batches, parallel arm execution, review loop, diff capture, nudges
- `src/agents/` — One adapter per agent CLI (`claude.ts`, `cursor.ts`, `codex.ts`): per-worktree Unblocked blocking, spawn args, resume, and a translator into the canonical transcript. `session.ts` is the shared spawn loop with the timeout and contamination guards
- `src/transcript.ts` — Canonical transcript parser. The canonical format is Claude Code's stream-json; every analysis reads it
- `src/worktree.ts` — Worktree creation and cleanup
- `src/review.ts` — Shared requirement list, per-round check, disputes and waivers
- `src/analyst.ts` — Structured single-turn model calls, blinding
- `src/attribution.ts` — Per-message cost/time walk and work/verify/housekeeping labels
- `src/quality.ts` — Blinded quality judge and tie-breaker
- `src/impact.ts`, `src/economics.ts` — Context-impact pass and cost/time breakdown
- `src/report.ts` — Console + HTML + JSON comparison reports, batch summary
- `src/git.ts`, `src/util.ts`, `src/types.ts` — Git helpers, pricing and formatting, shared types
- `scripts/report_from_jsonl.ts` — Regenerate a report from saved transcripts
- `src/simulate/` — the simulator: `index.ts` (CLI, YAML fixtures), `runner.ts` (the two chains), `prompts.ts`, one invoker per agent (`claude.ts`, `codex.ts`, `cursor.ts`, `grok.ts`), `report.ts`/`html-report.ts`. Sample fixture: `examples/simulate-fixture.yaml`

## Adding an agent

Implement `Agent` in `src/agents/<name>.ts` and register it in `src/agents/index.ts`. The translator must emit Claude Code tool names and inputs (`Bash.command`, `Read`/`Edit`/`Write.file_path`, `mcp__<server>__<tool>`) and name the Unblocked MCP server `unblocked`: the contamination guard, attribution, judge and impact passes key on them. Add translator cases to `src/agents/translate.test.ts`.

## Conventions

- Bun + TypeScript, no build step
- Use `bun <file>` not `node <file>`
- `bun test` and `bun run typecheck` before committing
- Error handling: throw on unrecoverable, log + continue on per-run failures
