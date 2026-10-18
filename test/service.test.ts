import { appendFileSync, existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeSource } from "../src/sources/claude-code.js";
import { Store } from "../src/store.js";
import { Core } from "../src/service/core.js";
import { startDaemon } from "../src/service/daemon.js";
import { plist } from "../src/service/launchd.js";
import { Coalescer } from "../src/service/queue.js";
import { AlreadyRunning, connect, RemoteApi, serve } from "../src/service/rpc.js";
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
      expect(res.groups[0]!.hits[0]!.exchange.assistant).toContain("Qwen3");
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
