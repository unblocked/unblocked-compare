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

// A shell command that publishes outside the working copy: a push, or a GitHub
// write through gh (PRs, issues, comments, reviews, API writes). Agents must
// not do this during a comparison; on ENG-735 one pushed and opened a PR.
const OUTWARD = [
  /\bgit\s+push\b/,
  /\bgh\s+(pr|issue|release|repo)\s+(create|merge|close|edit|comment|review|reopen|ready|delete|fork)\b/,
  /\bgh\s+api\b[^|;&]*(?:-X|--method)\s*(?:POST|PATCH|PUT|DELETE)\b/i,
  /\bgh\s+api\b(?![^|;&]*(?:-X|--method)\s*GET\b)[^|;&]*\s(?:-f|-F|--field|--raw-field|--input)\s/,
];

export function outwardAction(command: string): string | null {
  for (const re of OUTWARD) {
    const m = command.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

export function unblockedCommand(command: string): UnblockedCommand | null {
  const m = command.match(CLI);
  return m ? { tool: m[2], path: m[1] } : null;
}
