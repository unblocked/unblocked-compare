// Recognising an Unblocked CLI call in a shell command: `unblocked
// context-research ...`, possibly after `cd x &&`, and possibly by path (the
// simulated engine's shim is called by its absolute path, since login shells
// reorder PATH).
const CLI = /(?:^|[;&|(]\s*)((?:\S*\/)?)unblocked\s+(context[_-][\w-]+)/;

export interface UnblockedCommand {
  // "context-research", "context_get_urls", ...
  tool: string;
  // The directory prefix it was called by; "" for a bare `unblocked`.
  path: string;
}

export function unblockedCommand(command: string): UnblockedCommand | null {
  const m = command.match(CLI);
  return m ? { tool: m[2], path: m[1] } : null;
}
