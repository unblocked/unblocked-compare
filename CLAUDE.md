# unblocked-compare

Two tools for measuring what Unblocked adds to a coding agent:

- `bun run compare` (`src/`) — A/B: run a task in a coding agent (Claude Code, Cursor or Codex) with and without the Unblocked tools, then compare results.
- `bun run simulate` (`src/simulate/index.ts`) — the same harness with a simulated context engine in place of Unblocked: the Unblocked arm's `unblocked` CLI is a shim (`src/engine/`) that runs a read-only research agent (the same agent CLI, with its MCP servers) in the original repo and returns Unblocked-format results. Takes YAML fixtures and `--criteria`.

## Running

```bash
bun start -- --repo /path/to/repo --task "implement feature X"                  # Claude Code
bun start -- --agent cursor --repo /path/to/repo --task "implement feature X"
bun start -- --agent codex --model gpt-5.5 --repo /path/to/repo --task "implement feature X"
```

`--repo` is the customer's application repository, not this one. Defaults to a batch of 2 comparisons (`--repeat 2`); pass `--repeat 1` for one. `--review` adds the requirement check and fix loop. See README for all flags.

The analysis passes always run through `claude -p`, whatever agent is under test. Order after both arms: requirement revision → blinded judge → economics → impact (episodes) → tie-breaker → context's influence → Summary.

Re-render a report after a report or style change, free: `bun run render <result-dir>`. Consolidate repeats of one ticket (one Opus 5.5 call): `bun run consolidate <run-or-batch-dirs>`; a consistent difference across comparable runs is read as the context's influence. Rebuild a result from saved transcripts after an analysis change: `bun scripts/report_from_jsonl.ts` (see README).

Binary overrides: `CLAUDE_BINARY` (default `claude`), `CURSOR_BINARY` (default `agent`), `CODEX_BINARY` (default `codex`).

## Architecture

- `src/index.ts` — CLI flags and defaults
- `src/runner.ts` — Orchestrate: batches, parallel arm execution, review loop, diff capture, nudges
- `src/agents/` — One adapter per agent CLI (`claude.ts`, `cursor.ts`, `codex.ts`): per-worktree Unblocked blocking, spawn args, resume, and a translator into the canonical transcript. `session.ts` is the shared spawn loop with the timeout and contamination guards
- `src/transcript.ts` — Canonical transcript parser. The canonical format is Claude Code's stream-json; every analysis reads it
- `src/worktree.ts` — Isolated per-arm clones (`--shared`, base commit only, submodules from local copies) and push blocking (`noPushEnv`)
- `src/unblocked-cli.ts` — Recognises Unblocked CLI calls (bare or by path) and outward actions (`git push`, `gh` writes) in shell commands; the session guard kills a run on either
- `src/review.ts` — Shared requirement list, per-round check, disputes and waivers
- `src/analyst.ts` — Structured single-turn model calls, blinding
- `src/attribution.ts` — Per-message cost/time walk and work/verify/housekeeping labels
- `src/revision.ts` — Blinded requirement revision: restates a requirement to a team decision quoted verbatim from an arm's tool results (the quote is checked)
- `src/quality.ts` — Blinded quality judge and tie-breaker
- `src/impact.ts`, `src/economics.ts` — Context-impact pass (including the episodes and their cause: context, agent or environment) and cost/time breakdown
- `src/context-effect.ts` — Context's influence (Baseline + the Unblocked arm's context episodes − the Baseline's), the exact split of the measured difference, and the Summary writer. Unblocked only supplies context; the agent does all the work and makes every choice: keep that wording in prompts and report copy
- `src/report.ts`, `src/report-style.ts` — Console + HTML + JSON comparison reports and batch summary; the report's CSS and fonts. Green means better and red worse, nowhere else
- `src/git.ts`, `src/util.ts`, `src/types.ts` — Git helpers, pricing and formatting, shared types
- `scripts/report_from_jsonl.ts` — Regenerate a result and report from saved transcripts
- `scripts/render_report.ts` — Re-render `report.html` from `result.json` (`bun run render`)
- `src/consolidate.ts`, `scripts/consolidate.ts` — Cross-run consolidation: comparable runs, patterns, and the context's influence from consistent differences (`bun run consolidate`)
- `src/simulate/index.ts` — `simulate` CLI: fixtures and flags → a compare `Config` with `contextEngine` set
- `src/engine/` — simulated context engine: `cli.ts` (the fake `unblocked`), `shim.ts` (PATH shim, UC_ENGINE_* env, call log), `prompt.ts` (research prompts), `args.ts`, `discount.ts` (each research call counts as at most 20s in the arm's timings)

## Adding an agent

Implement `Agent` in `src/agents/<name>.ts` and register it in `src/agents/index.ts`. The translator must emit Claude Code tool names and inputs (`Bash.command`, `Read`/`Edit`/`Write.file_path`, `mcp__<server>__<tool>`) and name the Unblocked MCP server `unblocked`: the contamination guard, attribution, judge and impact passes key on them. Add translator cases to `src/agents/translate.test.ts`.

## Conventions

- Bun + TypeScript, no build step
- Use `bun <file>` not `node <file>`
- `bun test` and `bun run typecheck` before committing
- Error handling: throw on unrecoverable, log + continue on per-run failures
- Saved `result.json` files must keep loading: add fields as optional, and don't rename stored ones (the Summary is still stored as `contextEffect.tldr`)
- Agents under test must never publish: no push, no PR or issue writes. Keep the clone isolation, `noPushEnv` and the outward-action guard intact
