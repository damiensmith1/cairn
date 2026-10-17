import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "../src/embed.js";

let n = 0;
const ts = () => new Date(Date.UTC(2026, 9, 16, 10, 0, n++)).toISOString();

export const user = (text: string | unknown[], extra: Record<string, unknown> = {}) => ({
  type: "user",
  uuid: `u${n}`,
  timestamp: ts(),
  cwd: "/Users/me/projects/llm-cassette",
  message: { role: "user", content: text },
  ...extra,
});

export const assistant = (content: unknown[]) => ({
  type: "assistant",
  uuid: `a${n}`,
  timestamp: ts(),
  message: { role: "assistant", content },
});

export const text = (t: string) => ({ type: "text", text: t });
export const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `t${n}`, name, input });
export const toolResult = () => user([{ type: "tool_result", tool_use_id: "t", content: "ok" }]);

/** A fake projects dir with one transcript per session. Returns the dir and each file's path. */
export function projectsDir(sessions: Record<string, unknown[]>): { root: string; files: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "cairn-test-"));
  const dir = join(root, "-Users-me-projects-llm-cassette");
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  for (const [session, entries] of Object.entries(sessions)) {
    files[session] = join(dir, `${session}.jsonl`);
    writeFileSync(files[session], entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  return { root, files };
}

/** Deterministic bag-of-words vectors: texts sharing words point the same way. */
export class FakeEmbedder implements Embedder {
  readonly id = "fake:bow";
  readonly dims = 64;
  calls = 0;
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    return texts.map((t) => {
      const v = new Float32Array(this.dims);
      for (const w of t.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
        let h = 0;
        for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        v[h % this.dims]! += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}
