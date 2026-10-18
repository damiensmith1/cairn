import { mkdtempSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEntry } from "plainlog";
import { InMemoryTransport } from "plainlog/transports";
import { describe, expect, it } from "vitest";
import { Core } from "../src/service/core.js";
import { startDaemon } from "../src/service/daemon.js";
import { connect, RemoteApi } from "../src/service/rpc.js";
import { ClaudeCodeSource } from "../src/sources/claude-code.js";
import { Store } from "../src/store.js";
import { history, readUsage, UsageLog } from "../src/usage.js";
import { assistant, FakeEmbedder, projectsDir, text, user } from "./helpers.js";

const KEY = `sk-ant-api03-${"x".repeat(40)}`;
const entry = (message: string, meta: Record<string, unknown>, at: string): LogEntry => ({ level: "info", message, timestamp: at, meta });

describe("usage log", () => {
  it("records searches and opens with secrets masked", async () => {
    const memory = new InMemoryTransport();
    const usage = new UsageLog(undefined, memory);
    usage.search({ query: `where did we use ${KEY}`, client: "mcp", session: "s1", hits: [3, 1], ms: 12 });
    usage.open({ id: 3, client: "mcp", session: "s1" });
    await usage.flush();
    const [search, open] = memory.getLogs();
    expect(search).toMatchObject({ message: "search", meta: { client: "mcp", session: "s1", hits: [3, 1], ms: 12 } });
    expect(search!.meta!.query).toBe("where did we use [anthropic key]");
    expect(open).toMatchObject({ message: "open", meta: { id: 3, client: "mcp" } });
  });

  it("writes JSON lines to an owner-only file, creating its folder", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cairn-usage-")), "logs", "usage.jsonl");
    const usage = new UsageLog(file);
    usage.search({ query: "storage", client: "cli", hits: [1], ms: 5 });
    await usage.flush();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
    expect(readUsage(file)).toMatchObject([{ message: "search", meta: { query: "storage", client: "cli" } }]);
  });

  it("links each open to the asker's latest search that returned it", () => {
    const rows = history([
      entry("search", { query: "a", client: "mcp", session: "s1", hits: [1, 2, 3], ms: 1 }, "t1"),
      entry("search", { query: "b", client: "cli", hits: [5], ms: 1 }, "t2"),
      entry("open", { id: 2, client: "mcp", session: "s1" }, "t3"),
      entry("open", { id: 5, client: "cli" }, "t4"),
      entry("open", { id: 9, client: "mcp", session: "s1" }, "t5"), // not a result: ignored
      entry("search", { query: "c", client: "mcp", session: "s1", hits: [7], ms: 1 }, "t6"),
      entry("open", { id: 1, client: "mcp", session: "s1" }, "t7"), // from the earlier search: not linked
      entry("open", { id: 2, client: "mcp", session: "s2" }, "t8"), // another session's open
    ]);
    expect(rows.map((r) => [r.query, r.opened])).toEqual([
      ["a", [2]],
      ["b", [5]],
      ["c", []],
    ]);
  });

  it("is written by cairnd for searches and opens, with who asked", async () => {
    const { root, files } = projectsDir({ s: [user("which storage for cairn?"), assistant([text("SQLite with FTS5 and sqlite-vec.")])] });
    const old = Date.now() / 1000 - 3600;
    utimesSync(files.s!, old, old);
    const embedder = new FakeEmbedder();
    const core = new Core(new Store(":memory:", embedder.dims), embedder, [new ClaudeCodeSource(root)], undefined, undefined);
    const memory = new InMemoryTransport();
    core.usage = new UsageLog(undefined, memory);
    const socket = join(mkdtempSync(join(tmpdir(), "cairn-sock-")), "s.sock");
    const daemon = await startDaemon(core, { socket, log: () => {} });
    const api = new RemoteApi((await connect(socket))!);
    try {
      await daemon.indexNow();
      const res = await api.search({ query: "storage", rerank: false, client: "mcp", askingSession: "agent-session" });
      const seq = res.groups[0]!.hits[0]!.exchange.seq;
      await api.open(seq, 1, { client: "mcp", askingSession: "agent-session" });
      await core.usage.flush();
      const [search, open] = memory.getLogs();
      expect(search).toMatchObject({ message: "search", meta: { query: "storage", client: "mcp", session: "agent-session", hits: [seq] } });
      expect(open).toMatchObject({ message: "open", meta: { id: seq, client: "mcp", session: "agent-session" } });
      expect(history(memory.getLogs())[0]!.opened).toEqual([seq]);
      // What `cairn history <n>` uses: the logged ids, in order, minus any no longer stored.
      expect((await api.exchanges([999_999, seq])).map((x) => x.seq)).toEqual([seq]);
    } finally {
      api.close();
      await daemon.stop();
    }
  });
});
