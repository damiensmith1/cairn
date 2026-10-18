import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Exchange } from "../types.js";
import type { ReadResult, ReadState, Source } from "./source.js";

/** Characters of the previous reply carried into the next exchange. */
export const TAIL_CHARS = 600;

/** User entries that are harness noise, not something the user typed. */
const NOISE = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<task-notification>",
  "<system-reminder>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<user-prompt-submit-hook>",
];

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

type Entry = Record<string, any>;

/** The text the user typed, or "" if this entry isn't a typed message (tool results, noise, meta). */
export function typedText(e: Entry): string {
  if (e.type !== "user" || e.isMeta || e.isCompactSummary || e.isSidechain) return "";
  const content = e.message?.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => b?.type === "tool_result")) return "";
    text = content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  text = text.trim();
  return text && !NOISE.some((n) => text.startsWith(n)) ? text : "";
}

/**
 * First line of the commit message in a `git commit` shell command, if there is one. Only a real
 * `git commit` invocation counts (at the start of the command or after `&&`, `;`, `|`, `(` or a
 * newline, optionally `git -C <dir> commit`), and the message is read after it: a script that
 * merely mentions "git commit", or a heredoc earlier in the command, isn't a commit message.
 */
export function commitMessage(command: string): string | undefined {
  const invocation = /(?:^|[;&|(\n])\s*git(?:\s+-C\s+\S+)?\s+commit\b/.exec(command);
  if (!invocation) return undefined;
  // The message is on the commit's own line: `-m "…"`, or a heredoc that starts there.
  const rest = command.slice(invocation.index + invocation[0].length);
  const heredoc = /^[^\n]*?<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\s*\1/.exec(rest);
  const flag = /^[^\n]*?(?:^|\s)-m\s+(["'])([\s\S]*?)\1/.exec(rest);
  const message = heredoc?.[2] ?? flag?.[2];
  const first = message?.split("\n").find((l) => l.trim())?.trim();
  return first ? first.slice(0, 200) : undefined;
}

/** Project name from a working directory; Claude Code worktrees count as their repo. */
export function projectOf(cwd: string): string {
  const repo = cwd.split("/.claude/worktrees/")[0] ?? cwd;
  return basename(repo) || cwd;
}

interface Building {
  uuid: string;
  offset: number;
  at: string;
  cwd: string;
  user: string;
  assistant: string[];
  files: Set<string>;
  commits: string[];
}

/** Reads Claude Code transcripts: `<projects dir>/<encoded cwd>/<session id>.jsonl`. */
export class ClaudeCodeSource implements Source {
  readonly id = "claude-code";

  constructor(private readonly root: string) {}

  roots(): string[] {
    return [this.root];
  }

  async locations(): Promise<string[]> {
    const out: string[] = [];
    let dirs: string[];
    try {
      dirs = await readdir(this.root);
    } catch {
      return out;
    }
    for (const dir of dirs) {
      let files: string[];
      try {
        files = await readdir(join(this.root, dir));
      } catch {
        continue;
      }
      // Top level only: subagent transcripts live in nested folders and aren't read in v1.
      for (const f of files) if (f.endsWith(".jsonl")) out.push(join(this.root, dir, f));
    }
    return out.sort();
  }

  async read(location: string, state: ReadState, final: boolean): Promise<ReadResult> {
    const handle = await open(location, "r");
    let buffer: Buffer;
    try {
      const { size } = await handle.stat();
      if (size <= state.offset) return { exchanges: [], state };
      buffer = Buffer.alloc(size - state.offset);
      await handle.read(buffer, 0, buffer.length, state.offset);
    } finally {
      await handle.close();
    }

    // Only complete lines: a session may be mid-write.
    const end = buffer.lastIndexOf(0x0a) + 1;
    const session = basename(location, ".jsonl");
    const exchanges: Exchange[] = [];
    let { prevTail, sessionName } = state;
    let current: Building | undefined;

    const emit = (b: Building) => {
      const assistant = b.assistant.join("\n").trim();
      exchanges.push({
        hash: createHash("sha256").update(JSON.stringify([this.id, session, b.uuid, b.user, assistant])).digest("hex"),
        source: this.id,
        project: projectOf(b.cwd),
        cwd: b.cwd,
        session,
        sessionName,
        at: b.at,
        user: b.user,
        assistant,
        prevTail,
        files: [...b.files],
        commits: b.commits,
        location,
        offset: b.offset,
      });
      prevTail = assistant.slice(-TAIL_CHARS);
    };

    let pos = 0;
    while (pos < end) {
      const next = buffer.indexOf(0x0a, pos);
      const line = buffer.subarray(pos, next).toString("utf8");
      const lineOffset = state.offset + pos;
      pos = next + 1;
      let e: Entry;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "agent-name" && typeof e.agentName === "string" && e.agentName !== "New conversation") {
        sessionName = e.agentName;
        continue;
      }
      const typed = typedText(e);
      if (typed) {
        if (current) emit(current);
        current = {
          uuid: String(e.uuid ?? lineOffset),
          offset: lineOffset,
          at: String(e.timestamp ?? ""),
          cwd: String(e.cwd ?? ""),
          user: typed,
          assistant: [],
          files: new Set(),
          commits: [],
        };
        continue;
      }
      if (e.type === "assistant" && current && !e.isSidechain && Array.isArray(e.message?.content)) {
        for (const block of e.message.content) {
          if (block?.type === "text" && typeof block.text === "string") current.assistant.push(block.text);
          if (block?.type !== "tool_use") continue;
          const input = block.input ?? {};
          if (EDIT_TOOLS.has(block.name)) {
            const file = input.file_path ?? input.notebook_path;
            if (typeof file === "string") current.files.add(file);
          }
          if (block.name === "Bash" && typeof input.command === "string") {
            const message = commitMessage(input.command);
            if (message) current.commits.push(message);
          }
        }
      }
    }

    // The exchange still in progress is read again next time, unless the session is idle.
    let offset = state.offset + end;
    if (current) {
      if (final) emit(current);
      else offset = current.offset;
    }
    return { exchanges, state: { offset, prevTail, sessionName } };
  }
}
