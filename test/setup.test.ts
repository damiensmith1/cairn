import { mkdtempSync, readFileSync, statSync, utimesSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandHome, loadConfig, saveConfig, tildify } from "../src/config.js";
import { anthropicKey, FileStore, keychainAddCommand, type KeyStore, looksLikeKey } from "../src/credentials.js";
import { embedPending, ingest } from "../src/ingest.js";
import { pullModel, type PullProgress } from "../src/ollama.js";
import { ClaudeCodeSource } from "../src/sources/claude-code.js";
import { MAX_EMBED_ATTEMPTS, Store } from "../src/store.js";
import { assistant, FakeEmbedder, projectsDir, text, user } from "./helpers.js";

const tmp = () => mkdtempSync(join(tmpdir(), "cairn-setup-"));
const KEY = `sk-ant-api03-${"x".repeat(40)}`;

describe("credentials", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it("accepts only plausible keys, so nothing odd reaches the Keychain command", () => {
    expect(looksLikeKey(KEY)).toBe(true);
    expect(looksLikeKey("sk-ant-short")).toBe(false);
    expect(looksLikeKey(`${KEY} `)).toBe(false);
    expect(looksLikeKey(`${KEY}" -s other`)).toBe(false);
    expect(looksLikeKey(`${KEY}\ndelete-generic-password`)).toBe(false);
    expect(() => keychainAddCommand(`${KEY}"\nquit`)).toThrow();
    const cmd = keychainAddCommand(KEY);
    expect(cmd).toContain(`-w "${KEY}"`);
    expect(cmd.trimEnd().split("\n")).toHaveLength(1);
  });

  it("keeps the fallback file owner-only and removes it on delete", () => {
    const file = join(tmp(), "home", "credentials");
    const store = new FileStore(file);
    expect(store.get()).toBeUndefined();
    store.set(KEY);
    expect(store.get()).toBe(KEY);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => store.set("nope")).toThrow();
    store.delete();
    expect(store.get()).toBeUndefined();
  });

  it("prefers ANTHROPIC_API_KEY over the stored key", () => {
    const stored: KeyStore = { where: "test", get: () => KEY, set: () => {}, delete: () => {} };
    delete process.env.ANTHROPIC_API_KEY;
    expect(anthropicKey(stored)).toEqual({ key: KEY, from: "test" });
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
    expect(anthropicKey(stored)).toEqual({ key: "sk-ant-from-env", from: "ANTHROPIC_API_KEY" });
  });
});

describe("config", () => {
  it("round-trips, owner-only, with ~ paths", () => {
    const file = join(tmp(), "config.toml");
    expect(loadConfig(file)).toBeUndefined();
    saveConfig({ sources: { "claude-code": { enabled: true, paths: ["~/.claude/projects", "/srv/claude"] } } }, file);
    expect(loadConfig(file)).toEqual({ sources: { "claude-code": { enabled: true, paths: ["~/.claude/projects", "/srv/claude"] } } });
    expect(readFileSync(file, "utf8")).toMatch(/^# Written by cairn init/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(expandHome("~/.claude/projects")).toBe(join(homedir(), ".claude/projects"));
    expect(tildify(join(homedir(), ".claude/projects"))).toBe("~/.claude/projects");
    expect(tildify("/srv/claude")).toBe("/srv/claude");
  });
});

/** Fails on any text containing POISON, or on everything while `down`. */
class FlakyEmbedder extends FakeEmbedder {
  down = false;
  override async embed(texts: string[]) {
    if (this.down || texts.some((t) => t.includes("POISON"))) throw new Error("embedding failed");
    return super.embed(texts);
  }
  async problem() {
    return this.down ? "Ollama isn't running" : undefined;
  }
}

describe("fault-tolerant embedding", () => {
  async function setup() {
    const { root, files } = projectsDir({
      s1: [user("first question"), assistant([text("first answer")]), user("POISON question"), assistant([text("bad")]), user("third question"), assistant([text("third answer")])],
    });
    const old = Date.now() / 1000 - 3600;
    for (const f of Object.values(files)) utimesSync(f, old, old);
    const embedder = new FlakyEmbedder();
    const store = new Store(":memory:", embedder.dims);
    await ingest(store, [new ClaudeCodeSource(root)]);
    return { store, embedder };
  }

  it("embeds the rest of a batch and sets a bad exchange aside after repeated failures", async () => {
    const { store, embedder } = await setup();
    const first = await embedPending(store, embedder, { retryDelays: [] });
    expect(first).toMatchObject({ total: 3, done: 2, failed: 1 });
    expect(store.stats(embedder.id)).toMatchObject({ embedded: 2, failed: 0 });

    // Later runs retry it until it has failed MAX_EMBED_ATTEMPTS times, then leave it alone.
    for (let run = 1; run < MAX_EMBED_ATTEMPTS; run++) await embedPending(store, embedder, { retryDelays: [] });
    expect(store.stats(embedder.id)).toMatchObject({ embedded: 2, failed: 1 });
    expect(store.countUnembedded(embedder.id)).toBe(0);
    expect((await embedPending(store, embedder, { retryDelays: [] })).total).toBe(0);
    expect(store.embedFailures(embedder.id)[0]).toMatchObject({ attempts: MAX_EMBED_ATTEMPTS, error: "embedding failed" });

    // --retry-failed puts it back in the queue.
    expect(store.clearEmbedFailures(embedder.id)).toBe(1);
    expect(store.countUnembedded(embedder.id)).toBe(1);
  });

  it("stops without blaming any exchange when the embedder itself is down, and resumes later", async () => {
    const { store, embedder } = await setup();
    embedder.down = true;
    await expect(embedPending(store, embedder, { retryDelays: [] })).rejects.toThrow("Ollama isn't running");
    expect(store.embedFailures(embedder.id)).toHaveLength(0);
    embedder.down = false;
    expect(await embedPending(store, embedder, { retryDelays: [] })).toMatchObject({ done: 2, failed: 1 });
  });
});

describe("pullModel", () => {
  it("reads Ollama's progress stream even when lines arrive split", async () => {
    const lines = [{ status: "pulling manifest" }, { status: "downloading", completed: 50, total: 100 }, { status: "success" }].map((l) => JSON.stringify(l)).join("\n") + "\n";
    const server = createServer((_req, res) => {
      res.write(lines.slice(0, 30));
      setTimeout(() => res.end(lines.slice(30)), 20);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const seen: PullProgress[] = [];
      await pullModel("m", (p) => seen.push(p), `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      expect(seen.map((p) => p.status)).toEqual(["pulling manifest", "downloading", "success"]);
      expect(seen[1]).toMatchObject({ completed: 50, total: 100 });
    } finally {
      server.close();
    }
  });

  it("surfaces Ollama's error after its last attempt", async () => {
    const server = createServer((_req, res) => res.end(`${JSON.stringify({ error: "pull model manifest: file does not exist" })}\n`));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await expect(pullModel("nope", () => {}, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, 1)).rejects.toThrow("file does not exist");
    } finally {
      server.close();
    }
  });
});
