import { appendFileSync, existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeSource } from "../src/sources/claude-code.js";
import { Store } from "../src/store.js";
import { Core } from "../src/service/core.js";
import { startDaemon } from "../src/service/daemon.js";
import { nodePath, plist } from "../src/service/launchd.js";
import { Coalescer } from "../src/service/queue.js";
import { AlreadyRunning, connect, RemoteApi, serve } from "../src/service/rpc.js";
import { Feed, formatEvent } from "../src/live.js";
import { assistant, FakeEmbedder, projectsDir, text, user } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const socketIn = () => join(mkdtempSync(join(tmpdir(), "cairn-svc-")), "cairnd.sock");

describe("Coalescer", () => {
  it("runs one job at a time and folds triggers during a run into one more run", async () => {
    let runs = 0;
    let release!: () => void;
    const q = new Coalescer(async () => {
      runs++;
      await new Promise<void>((r) => (release = r));
      return runs;
    });
    const first = q.trigger();
    const [a, b, c] = [q.trigger(), q.trigger(), q.trigger()];
    expect(runs).toBe(1);
    release();
    expect(await first).toBe(1);
    await sleep(0);
    expect(runs).toBe(2); // the three triggers share one follow-up run
    release();
    expect(await Promise.all([a, b, c])).toEqual([2, 2, 2]);
    await q.idle();
    expect(q.busy).toBe(false);
  });
});

describe("JSON-RPC over a Unix socket", () => {
  it("answers calls, reports errors, refuses a second server and clears a stale socket", async () => {
    const path = socketIn();
    const server = await serve(path, {
      echo: async (p: { x: number }) => ({ x: p.x * 2 }),
      boom: async () => {
        throw new Error("nope");
      },
    });
    const client = (await connect(path))!;
    expect(await client.call("echo", { x: 21 })).toEqual({ x: 42 });
    await expect(client.call("boom")).rejects.toThrow("nope");
    await expect(client.call("constructor")).rejects.toThrow("unknown method");
    await expect(serve(path, {})).rejects.toBeInstanceOf(AlreadyRunning);
    client.close();
    await server.close();
    expect(existsSync(path)).toBe(false);
    expect(await connect(path)).toBeUndefined();

    writeFileSync(path, ""); // a leftover file from a crash
    const again = await serve(path, {});
    await again.close();
  });
});

describe("cairnd", () => {
  it("catches up on start, indexes new exchanges as they're written, and answers searches", async () => {
    const { root, files } = projectsDir({
      s: [user("which storage for cairn?"), assistant([text("SQLite with FTS5 and sqlite-vec.")])],
    });
    const old = Date.now() / 1000 - 3600;
    utimesSync(files.s!, old, old);
    const embedder = new FakeEmbedder();
    const core = new Core(new Store(":memory:", embedder.dims), embedder, [new ClaudeCodeSource(root)], undefined, undefined);
    const socket = socketIn();
    const daemon = await startDaemon(core, { socket, debounceMs: 50, sweepMs: 200, log: () => {} });
    const api = new RemoteApi((await connect(socket))!);
    try {
      await daemon.indexNow();
      expect((await api.status()).stats.exchanges).toBe(1);

      // A new exchange completes when the next message arrives.
      appendFileSync(
        files.s!,
        [user("and the embedding model?"), assistant([text("Qwen3-Embedding, locally.")]), user("ok")].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      let n = 0;
      for (let i = 0; i < 50 && n < 2; i++) {
        await sleep(100);
        n = (await api.status()).stats.exchanges;
      }
      expect(n).toBe(2);

      const res = await api.search({ query: "embedding model", rerank: false });
      const hit = res.groups[0]!.hits[0]!.exchange;
      expect(hit.assistant).toContain("Qwen3");
      expect((await api.open(hit.seq, 1))?.exchanges.length).toBe(2);
      expect((await api.brief("s"))?.exchanges).toBe(2);
      const status = await api.status();
      expect(status.daemon?.pid).toBe(process.pid);
      expect(status.daemon?.lastIndex?.result.appended).toBeGreaterThanOrEqual(0);
    } finally {
      api.close();
      await daemon.stop();
    }
    expect(existsSync(socket)).toBe(false);
  });
});

describe("launchd plist", () => {
  it("runs Node by a path that resolves to this same binary", async () => {
    const { realpathSync } = await import("node:fs");
    expect(realpathSync(nodePath())).toBe(realpathSync(process.execPath));
    expect(nodePath()).not.toMatch(/\/Cellar\//);
  });

  it("runs cairnd at login at normal priority, restarting only after crashes", () => {
    const xml = plist({ program: ["/usr/bin/node", "/a b/cli.js", "daemon"], env: { CAIRN_HOME: "/x&y" }, logFile: "/tmp/c.log" });
    expect(xml).toContain("<string>local.cairn.cairnd</string>");
    expect(xml).toContain("<string>/a b/cli.js</string>");
    expect(xml).toContain("<string>/x&amp;y</string>");
    expect(xml).toMatch(/<key>ProcessType<\/key>\s*<string>Standard<\/string>/);
    expect(xml).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });
});

describe("live events", () => {
  it("streams what cairnd does to subscribers, with recent history for late joiners", async () => {
    const { root, files } = projectsDir({ s: [user("which storage?"), assistant([text("SQLite.")])] });
    const old = Date.now() / 1000 - 3600;
    utimesSync(files.s!, old, old);
    const embedder = new FakeEmbedder();
    const core = new Core(new Store(":memory:", embedder.dims), embedder, [new ClaudeCodeSource(root)], undefined, undefined);
    const socket = socketIn();
    const daemon = await startDaemon(core, { socket, debounceMs: 50, sweepMs: 60_000, log: () => {} });
    await daemon.indexNow();
    const api = new RemoteApi((await connect(socket))!);
    try {
      const seen: string[] = [];
      const history = await api.subscribe((e) => seen.push(e.type));
      // Joined after the first run: the history has it.
      expect(history.map((e) => e.type)).toEqual(expect.arrayContaining(["started", "read", "embedded", "index-done"]));
      await api.search({ query: "storage", rerank: false });
      appendFileSync(files.s!, [user("and embeddings?"), assistant([text("Qwen3.")]), user("ok")].map((e) => JSON.stringify(e)).join("\n") + "\n");
      for (let i = 0; i < 50 && !seen.includes("embedded"); i++) await sleep(100);
      expect(seen).toEqual(expect.arrayContaining(["search", "changed", "index-start", "read", "embedded", "index-done"]));
    } finally {
      api.close();
      await daemon.stop();
    }
  });

  it("formats events as feed lines, leaving sweeps and run starts to the header", () => {
    const at = new Date().toISOString();
    expect(formatEvent({ type: "search", at, query: "sqlite", hits: 3, reranked: true, ms: 380 })?.text).toBe('"sqlite" · 3 hits · reranked · 380 ms');
    expect(formatEvent({ type: "embedded", at, exchanges: 1, chunks: 2, ms: 410 })?.text).toBe("1 exchange · 2 chunks · 410 ms");
    expect(formatEvent({ type: "embedding", at, done: 5, total: 10, chunks: 6 })?.key).toBe("embedding");
    expect(formatEvent({ type: "sweep", at })).toBeUndefined();
    const quiet = { files: 404, changed: 0, appended: 0, reparsed: 0, linked: 0, embedded: 0, chunks: 0, failed: 0, labelled: 0, labels: false };
    expect(formatEvent({ type: "index-done", at, ms: 12, result: quiet })).toBeUndefined();
  });
});

describe("live feed", () => {
  const at = new Date().toISOString();
  const changed = { type: "changed" as const, at, files: [{ file: "p/s1.jsonl", session: "s1", name: "Clance Chat" }] };
  const read = (appended: number) => ({ type: "read" as const, at, files: 404, changed: 1, appended, ms: 40 });

  it("folds a session being written into one line that counts updates", () => {
    const feed = new Feed();
    for (let i = 0; i < 3; i++) {
      feed.push(changed);
      feed.push(read(0));
    }
    expect(feed.lines).toHaveLength(1);
    expect(feed.lines[0]).toMatchObject({ kind: "writing", text: "Clance Chat · exchange in progress (3 updates)" });
  });

  it("shows the exchange once it completes, naming the session", () => {
    const feed = new Feed();
    feed.push(changed);
    feed.push(read(0));
    feed.push(changed);
    feed.push(read(1));
    expect(feed.lines.map((l) => l.kind)).toEqual(["writing", "read"]);
    expect(feed.lines[1]!.text).toBe("1 new exchange from Clance Chat · 40 ms");
  });
});
