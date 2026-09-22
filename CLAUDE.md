# claude-harness

A/B comparison: run a task with Claude Code with and without Unblocked context, then compare results.

## Running

```bash
bun start -- --repo /path/to/repo --task "implement feature X"
```

Defaults to a batch of 2 comparisons (`--repeat 2`); pass `--repeat 1` for one. `--review` adds the requirement check and fix loop. See README for all flags.

Set `CLAUDE_BINARY` env var to override binary name (default: `claude`).

## Architecture

- `src/index.ts` — CLI flags and defaults
- `src/runner.ts` — Orchestrate: batches, parallel arm execution, review loop, diff capture, nudges
- `src/claude.ts` — Spawn Claude Code CLI, parse stream-json, manage worktrees, contamination detection
- `src/review.ts` — Shared requirement list, per-round check, disputes and waivers
- `src/analyst.ts` — Structured single-turn model calls, blinding
- `src/attribution.ts` — Per-message cost/time walk and work/verify/housekeeping labels
- `src/quality.ts` — Blinded quality judge and tie-breaker
- `src/impact.ts`, `src/economics.ts` — Context-impact pass and cost/time breakdown
- `src/report.ts` — Console + HTML + JSON comparison reports, batch summary
- `src/git.ts`, `src/util.ts`, `src/types.ts` — Git helpers, pricing and formatting, shared types
- `scripts/report_from_jsonl.ts` — Regenerate a report from saved transcripts

## Conventions

- Bun + TypeScript, no build step
- Use `bun <file>` not `node <file>`
- Error handling: throw on unrecoverable, log + continue on per-run failures
