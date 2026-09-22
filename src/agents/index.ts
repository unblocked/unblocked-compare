import type { Agent, AgentName } from "./types.ts";
import { claude } from "./claude.ts";
import { cursor } from "./cursor.ts";
import { codex } from "./codex.ts";

export type { Agent, AgentName } from "./types.ts";

export const AGENTS: Record<AgentName, Agent> = { claude, cursor, codex };
