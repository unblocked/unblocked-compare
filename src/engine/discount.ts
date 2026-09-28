// A simulated research call takes minutes where the real service takes
// seconds, so its time is not part of the comparison: each call counts as the
// lesser of its actual time and ENGINE_CALL_CAP_MS. Applied to the canonical
// transcript by moving every later event back by the excess, so the arm's
// duration, the attribution walk, tool wait and the economics all agree.
import fs from "node:fs";

import { unblockedCommand } from "../unblocked-cli.ts";

export const ENGINE_CALL_CAP_MS = 20_000;

interface Event {
  type?: string;
  subtype?: string;
  timestamp?: string;
  duration_ms?: number;
  message?: { content?: { type: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string }[] };
}

// Rewrites the transcript in place (keeping the original as
// <name>.unadjusted.jsonl) and returns the milliseconds removed. Without
// engineCommand (a saved run), any `unblocked` called by path is the engine:
// in a simulated arm a bare `unblocked` is the real service and kills the run.
export function discountEngineTime(jsonlPath: string, engineCommand?: string, capMs = ENGINE_CALL_CAP_MS): number {
  const lines = fs.readFileSync(jsonlPath, "utf8").split("\n");
  const events: (Event | null)[] = lines.map(l => { try { return l.trim() ? JSON.parse(l) : null; } catch { return null; } });
  const ms = (e: Event) => (typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN);

  // Engine call ids and when each started.
  const started = new Map<string, number>();
  for (const e of events) {
    if (e?.type !== "assistant") continue;
    for (const b of e.message?.content ?? []) {
      if (b.type !== "tool_use" || b.name !== "Bash" || !b.id) continue;
      const cli = unblockedCommand(String(b.input?.command ?? ""));
      const isEngine = cli && (engineCommand ? `${cli.path}unblocked` === engineCommand : cli.path !== "");
      if (isEngine && !Number.isNaN(ms(e))) started.set(b.id, ms(e));
    }
  }
  if (!started.size) return 0;

  let shift = 0, segmentShift = 0, total = 0;
  for (const e of events) {
    if (!e) continue;
    if (e.type === "harness" && e.subtype === "session_start") segmentShift = 0;
    // Shift first: a result's own time moves by the excess of calls before it.
    const t = ms(e);
    if (shift && !Number.isNaN(t)) e.timestamp = new Date(t - shift).toISOString();
    if (e.type === "user") {
      for (const b of e.message?.content ?? []) {
        const s = b.type === "tool_result" && b.tool_use_id ? started.get(b.tool_use_id) : undefined;
        if (s === undefined || Number.isNaN(t)) continue;
        const excess = Math.max(0, t - s - capMs);
        if (!excess) continue;
        shift += excess; segmentShift += excess; total += excess;
        // This result lands capMs after its call; later events move with it.
        e.timestamp = new Date(t - shift).toISOString();
      }
    }
    if (e.type === "result" && typeof e.duration_ms === "number" && segmentShift) {
      e.duration_ms = Math.max(0, e.duration_ms - segmentShift);
      segmentShift = 0;
    }
  }
  if (!total) return 0;

  const original = jsonlPath.replace(/\.jsonl$/, ".unadjusted.jsonl");
  if (!fs.existsSync(original)) fs.copyFileSync(jsonlPath, original);
  fs.writeFileSync(jsonlPath, lines.map((l, i) => (events[i] ? JSON.stringify(events[i]) : l)).join("\n"));
  return total;
}
