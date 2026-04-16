/**
 * Built-in tool definitions and executors.
 *
 * These are the standard tools available in every run — file operations,
 * shell execution, and code search. They execute locally on the customer's
 * machine against their repo.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { ToolDefinition } from "../providers/types.js";

// ── Tool definitions (passed to the model) ─────────────────────────────

export const BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "bash",
    description:
      "Execute a shell command and return its stdout/stderr. " +
      "Commands run in the repo working directory. " +
      "Use for: running tests, installing deps, git operations, build commands.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description:
      "Read the contents of a file. Returns the file content as text. " +
      "Use relative paths from the repo root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file (relative to repo root)",
        },
        offset: {
          type: "number",
          description: "Line number to start reading from (0-indexed). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to read. Optional.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file, creating it if it doesn't exist. " +
      "Overwrites existing content. Use relative paths from the repo root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file (relative to repo root)",
        },
        content: {
          type: "string",
          description: "The content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact string in a file with new content. " +
      "The old_string must match exactly (including whitespace). " +
      "Use relative paths from the repo root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file (relative to repo root)",
        },
        old_string: {
          type: "string",
          description: "The exact string to find and replace",
        },
        new_string: {
          type: "string",
          description: "The replacement string",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "search_files",
    description:
      "Search for files matching a glob pattern. Returns matching file paths. " +
      "Pattern examples: '**/*.ts', 'src/**/*.test.js', '*.md'",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match files",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents using a regular expression. " +
      "Returns matching lines with file paths and line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regular expression pattern to search for",
        },
        path: {
          type: "string",
          description:
            "Directory or file to search in (relative to repo root). Defaults to '.'",
        },
        include: {
          type: "string",
          description: "Glob pattern to filter files (e.g. '*.ts'). Optional.",
        },
      },
      required: ["pattern"],
    },
  },
];

// ── Tool executor ──────────────────────────────────────────────────────

const BASH_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 100_000;

function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_BYTES) return output;
  return (
    output.slice(0, MAX_OUTPUT_BYTES) +
    `\n\n... [truncated, ${output.length} total bytes]`
  );
}

export function executeBuiltinTool(
  name: string,
  input: Record<string, unknown>,
  repoPath: string
): { result: string; isError: boolean } {
  try {
    switch (name) {
      case "bash": {
        const command = input.command as string;
        if (!command) return { result: "Error: command is required", isError: true };
        try {
          const output = execSync(command, {
            cwd: repoPath,
            timeout: BASH_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { result: truncate(output || "(no output)"), isError: false };
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; status?: number };
          const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
          return {
            result: truncate(output || `Command failed with exit code ${e.status}`),
            isError: true,
          };
        }
      }

      case "read_file": {
        const filePath = resolve(repoPath, input.path as string);
        if (!existsSync(filePath)) {
          return { result: `Error: file not found: ${input.path}`, isError: true };
        }
        let content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        const offset = (input.offset as number) || 0;
        const limit = input.limit as number;
        if (offset > 0 || limit) {
          const sliced = lines.slice(offset, limit ? offset + limit : undefined);
          content = sliced
            .map((line, i) => `${offset + i + 1}\t${line}`)
            .join("\n");
        } else {
          content = lines.map((line, i) => `${i + 1}\t${line}`).join("\n");
        }
        return { result: truncate(content), isError: false };
      }

      case "write_file": {
        const filePath = resolve(repoPath, input.path as string);
        writeFileSync(filePath, input.content as string);
        return { result: `File written: ${input.path}`, isError: false };
      }

      case "edit_file": {
        const filePath = resolve(repoPath, input.path as string);
        if (!existsSync(filePath)) {
          return { result: `Error: file not found: ${input.path}`, isError: true };
        }
        const current = readFileSync(filePath, "utf-8");
        const oldStr = input.old_string as string;
        const newStr = input.new_string as string;
        const count = current.split(oldStr).length - 1;
        if (count === 0) {
          return {
            result: "Error: old_string not found in file",
            isError: true,
          };
        }
        if (count > 1) {
          return {
            result: `Error: old_string found ${count} times (must be unique)`,
            isError: true,
          };
        }
        writeFileSync(filePath, current.replace(oldStr, newStr));
        return { result: `File edited: ${input.path}`, isError: false };
      }

      case "search_files": {
        const pattern = input.pattern as string;
        try {
          const output = execSync(
            `find . -path './.git' -prune -o -name '${pattern.replace(/'/g, "\\'")}' -print | head -100`,
            { cwd: repoPath, encoding: "utf-8", timeout: 10_000 }
          );
          // Also try glob via bash
          const globOutput = execSync(
            `shopt -s globstar nullglob 2>/dev/null; ls -d ${pattern} 2>/dev/null | head -100`,
            { cwd: repoPath, encoding: "utf-8", timeout: 10_000, shell: "/bin/bash" }
          ).trim();
          const combined = globOutput || output.trim();
          return {
            result: combined || "No files found matching pattern",
            isError: false,
          };
        } catch {
          return { result: "No files found matching pattern", isError: false };
        }
      }

      case "grep": {
        const pattern = input.pattern as string;
        const searchPath = (input.path as string) || ".";
        const include = input.include as string;
        let cmd = `grep -rn --include='*' -E '${pattern.replace(/'/g, "\\'")}' '${searchPath}' | head -100`;
        if (include) {
          cmd = `grep -rn --include='${include}' -E '${pattern.replace(/'/g, "\\'")}' '${searchPath}' | head -100`;
        }
        try {
          const output = execSync(cmd, {
            cwd: repoPath,
            encoding: "utf-8",
            timeout: 15_000,
          });
          return { result: truncate(output || "No matches found"), isError: false };
        } catch {
          return { result: "No matches found", isError: false };
        }
      }

      default:
        return { result: `Unknown built-in tool: ${name}`, isError: true };
    }
  } catch (err: unknown) {
    const message = (err as Error)?.message || "Unknown error";
    return { result: `Error executing ${name}: ${message}`, isError: true };
  }
}
