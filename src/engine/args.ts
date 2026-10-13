// Argument parsing for the simulated `unblocked` CLI. Agents call it the way
// they call the real one: flags or positional query, dashes or underscores.
export function parseArgs(argv: string[]): { command: string; query: string; effort: string; urls: string[] } {
  const [command = "", ...rest] = argv;
  let query = "", effort = "low";
  const urls: string[] = [], positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = () => rest[++i] ?? "";
    if (a === "--query" || a === "-q") query = value();
    else if (a.startsWith("--query=")) query = a.slice(8);
    else if (a === "--effort") effort = value();
    else if (a.startsWith("--effort=")) effort = a.slice(9);
    else if (a === "--url" || a === "--urls") urls.push(...value().split(/[\s,]+/).filter(Boolean));
    else if (a.startsWith("--url=")) urls.push(a.slice(6));
    else if (!a.startsWith("-")) positional.push(a);
  }
  if (!query && positional.length) query = positional.join(" ");
  if (!urls.length && command.replace(/_/g, "-") === "context-get-urls") urls.push(...positional);
  return { command: command.replace(/_/g, "-"), query, effort, urls };
}
