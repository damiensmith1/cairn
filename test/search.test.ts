import { utimesSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chunkTexts, split } from "../src/chunk.js";
import { embedPending, ingest } from "../src/ingest.js";
import { fuse, search, type SearchOptions, timeWindow, toFtsQuery } from "../src/search.js";
import { ClaudeCodeSource } from "../src/sources/claude-code.js";
import { Store } from "../src/store.js";
import { assistant, FakeEmbedder, projectsDir, text, toolUse, user } from "./helpers.js";

describe("split", () => {
  it("leaves short text alone and overlaps long text", () => {
    expect(split("short", 100, 20)).toEqual(["short"]);
    const long = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
    const pieces = split(long, 400, 80);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 400)).toBe(true);
    // Each piece starts with the end of the one before it.
    expect(pieces[1]!.includes(pieces[0]!.slice(-50))).toBe(true);
    expect(pieces.join("").length).toBeGreaterThan(long.length);
  });
});

describe("toFtsQuery and fuse", () => {
  it("keeps meaningful words and ORs them", () => {
    expect(toFtsQuery("What did we decide about QUESTION_VERSION?")).toBe('"decide" OR "about" OR "question_version"');
    expect(toFtsQuery("what did we")).toBe("");
  });
  it("rewards items ranked high in both lists", () => {
    const s = fuse([
      [1, 2, 3],
      [3, 1, 4],
    ]);
    expect(s.get(1)).toBeGreaterThan(s.get(2)!);
    expect(s.get(3)).toBeGreaterThan(s.get(4)!);
  });
});

describe("ingest + embed + search", () => {
  const sessions = {
    threshold: [
      user("should the cassette threshold stay at 0.85?", { cwd: "/p/llm-cassette" }),
      assistant([text("Keep 0.85: one broken reply in 78 got through.")]),
      user("yes keep 0.85", { cwd: "/p/llm-cassette" }),
      assistant([text("Kept the default threshold.")]),
    ],
    sqlite: [
      user("which storage should cairn use, sqlite or an lsm tree?", { cwd: "/p/cairn" }),
      assistant([text("SQLite with FTS5 and sqlite-vec in one file.")]),
    ],
  };

  async function setup() {
    const { root, files } = projectsDir(sessions);
    const old = Date.now() / 1000 - 3600; // an hour ago: idle, so last exchanges count as complete
    for (const f of Object.values(files)) utimesSync(f, old, old);
    const embedder = new FakeEmbedder();
    const store = new Store(":memory:", embedder.dims);
    const source = new ClaudeCodeSource(root);
    return { store, embedder, source };
  }

  it("ingests idempotently and embeds every exchange once", async () => {
    const { store, embedder, source } = await setup();
    expect((await ingest(store, [source])).appended).toBe(3);
    expect((await ingest(store, [source])).appended).toBe(0);
    const p = await embedPending(store, embedder);
    expect(p.done).toBe(3);
    expect((await embedPending(store, embedder)).done).toBe(0);
    expect(store.stats(embedder.id)).toMatchObject({ exchanges: 3, sessions: 2, embedded: 3 });
  });

  it("finds by keyword and meaning, filters by project, groups by session", async () => {
    const { store, embedder, source } = await setup();
    await ingest(store, [source]);
    await embedPending(store, embedder);

    const groups = await search(store, embedder, "what did we decide about the threshold?");
    expect(groups[0]!.session).toBe("threshold");
    expect(groups[0]!.hits[0]!.via).toContain("keyword");

    const onlyCairn = await search(store, embedder, "storage", { project: "cairn" });
    expect(onlyCairn.map((g) => g.project)).toEqual(["cairn"]);
    expect(onlyCairn[0]!.hits[0]!.exchange.assistant).toContain("sqlite-vec");
  });

  it("embeds a header and the previous reply's tail with each exchange", async () => {
    const { store, source } = await setup();
    await ingest(store, [source]);
    const [, second] = store.exchanges([1, 2, 3]).filter((x) => x.session === "threshold");
    const [chunk] = chunkTexts(second!);
    expect(chunk).toContain("project: llm-cassette");
    expect(chunk).toContain("[previous reply, end] …Keep 0.85");
    expect(chunk).toContain("[user] yes keep 0.85");
  });
});

describe("time windows", () => {
  // One weak match in its own moment, and 60 stronger matches at other times: more than search's
  // candidate pool (50), so without filtering inside retrieval the weak one never gets a look in.
  async function setup(targetFirst: boolean) {
    // Timestamps follow creation order, so build the target before or after the crowd.
    const makeTarget = () => [user("an old note: the threshold was set once"), assistant([text("Set it once and moved on.")])];
    const makeCrowd = () => Array.from({ length: 60 }, (_, i) => [user(`threshold threshold question ${i}`), assistant([text("threshold threshold threshold")])]).flat();
    const [target, crowd] = targetFirst ? [makeTarget(), makeCrowd()] : (() => { const c = makeCrowd(); return [makeTarget(), c]; })();
    const { root, files } = projectsDir(targetFirst ? { a: target, b: crowd } : { b: crowd, a: target });
    const old = Date.now() / 1000 - 3600;
    for (const f of Object.values(files)) utimesSync(f, old, old);
    const embedder = new FakeEmbedder();
    const store = new Store(":memory:", embedder.dims);
    await ingest(store, [new ClaudeCodeSource(root)]);
    await embedPending(store, embedder);
    const at = target[0]!.timestamp as string;
    const users = async (opts: SearchOptions = {}) => (await search(store, embedder, "threshold", { limit: 10, ...opts })).flatMap((g) => g.hits.map((h) => h.exchange.user));
    return { users, at };
  }
  const second = (iso: string, d: number) => new Date(Date.parse(iso) + d * 1000).toISOString();

  it("finds a match inside the window that better matches elsewhere would crowd out", async () => {
    const { users, at } = await setup(true); // the target is the earliest exchange
    expect(await users()).not.toContain("an old note: the threshold was set once");
    expect(await users({ until: second(at, 1) })).toEqual(["an old note: the threshold was set once"]);
  });

  it("filters by since as well, and both together", async () => {
    const { users, at } = await setup(false); // the target is the latest exchange
    expect(await users({ since: at })).toEqual(["an old note: the threshold was set once"]);
    expect(await users({ since: at, until: second(at, 1) })).toEqual(["an old note: the threshold was set once"]);
    expect(await users({ since: second(at, 1) })).toEqual([]);
  });

  it("reads bare dates as local days, until through the end of its day", () => {
    const start = (d: string) => new Date(`${d}T00:00:00`).toISOString();
    expect(timeWindow("2026-10-17", "2026-10-17")).toEqual({ since: start("2026-10-17"), until: start("2026-10-18") });
    expect(timeWindow(undefined, "2026-10-31")).toEqual({ until: start("2026-11-01") });
    expect(timeWindow("2026-10-17T12:00:00Z")).toEqual({ since: "2026-10-17T12:00:00.000Z" });
    expect(() => timeWindow("last week")).toThrow(/Not a date/);
  });
});

describe("searching from inside a session", () => {
  // An agent in session "me" searches. Its first exchange was compacted away; the second is still
  // in its context, and a fork copied that second exchange into another session.
  async function setup(compacted: boolean) {
    const early = [user("what threshold should the cassette use?"), assistant([text("Keep the cassette threshold at 0.85.")])];
    const late = [user("so the cassette threshold stays at 0.85?"), assistant([text("Yes, the cassette threshold stays.")])];
    const boundary = { type: "system", subtype: "compact_boundary", timestamp: late[0]!.timestamp };
    const other = [user("cassette threshold for the replay tests?"), assistant([text("Replay tests use the same cassette threshold.")])];
    const { root, files } = projectsDir({ me: [...early, ...(compacted ? [boundary] : []), ...late], fork: late, other });
    const old = Date.now() / 1000 - 3600;
    for (const f of Object.values(files)) utimesSync(f, old, old);
    const embedder = new FakeEmbedder();
    const store = new Store(":memory:", embedder.dims);
    await ingest(store, [new ClaudeCodeSource(root)]);
    await embedPending(store, embedder);
    const users = async (askingSession?: string) =>
      (await search(store, embedder, "cassette threshold", askingSession ? { askingSession } : {})).flatMap((g) => g.hits.map((h) => `${g.session}: ${h.exchange.user}`)).sort();
    return { users };
  }

  it("leaves out what the asking session still has in context, and fork copies of it", async () => {
    const { users } = await setup(true);
    // Stored once, under whichever session was read first.
    expect((await users()).filter((u) => u.endsWith("so the cassette threshold stays at 0.85?"))).toHaveLength(1);
    expect(await users("me")).toEqual(["me: what threshold should the cassette use?", "other: cassette threshold for the replay tests?"]);
  });

  it("leaves out the whole session if it was never compacted", async () => {
    const { users } = await setup(false);
    expect(await users("me")).toEqual(["other: cassette threshold for the replay tests?"]);
  });
});

describe("Store file permissions", () => {
  it("keeps the data folder and database owner-only", async () => {
    const { mkdtempSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = join(mkdtempSync(join(tmpdir(), "cairn-perm-")), "home");
    const store = new Store(join(dir, "cairn.db"), 8);
    store.close();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "cairn.db")).mode & 0o777).toBe(0o600);
  });
});

describe("forks and snippets", () => {
  it("stores a forked session's copied exchanges once, and shows the matching part", async () => {
    const shared = [user("should we keep the threshold?"), assistant([text("Keep 0.85 for now.")])];
    const { root, files } = projectsDir({
      original: [...shared, user("ok"), assistant([text("Kept.")])],
      fork: [...shared, user("try 0.6 instead"), assistant([text("Switched to 0.6.")])],
    });
    const old = Date.now() / 1000 - 3600;
    for (const f of Object.values(files)) utimesSync(f, old, old);
    const embedder = new FakeEmbedder();
    const store = new Store(":memory:", embedder.dims);
    // Each session has 2 exchanges; the fork's first one is a copy of the original's.
    expect((await ingest(store, [new ClaudeCodeSource(root)])).appended).toBe(3);
    await embedPending(store, embedder);

    const groups = await search(store, embedder, "threshold");
    const all = groups.flatMap((g) => g.hits);
    expect(all.filter((h) => h.exchange.user === "should we keep the threshold?")).toHaveLength(1);
    expect(all[0]!.snippet).toContain("«threshold»");
  });
});

describe("keyword snippets", () => {
  it("find exchanges by file name but quote conversation, not file lists", async () => {
    const { root, files } = projectsDir({
      s: [
        user("why is the judge so slow?"),
        assistant([text("The judge waits on each call; batching would fix it."), toolUse("Edit", { file_path: "/r/src/match/judge.ts" })]),
      ],
    });
    const old = Date.now() / 1000 - 3600;
    utimesSync(files.s!, old, old);
    const embedder = new FakeEmbedder();
    const store = new Store(":memory:", embedder.dims);
    await ingest(store, [new ClaudeCodeSource(root)]);
    await embedPending(store, embedder);
    // Found through the file name, which lives in the meta column…
    const [hit] = (await search(store, embedder, "judge.ts")).flatMap((g) => g.hits);
    expect(hit!.via).toContain("keyword");
    // …but the snippet is conversation text, never the path list.
    expect(hit!.snippet).not.toContain("/r/src/match");
  });
});

describe("reranking", () => {
  it("reorders the top candidates by the reranker's scores and cuts to the limit", async () => {
    const { root, files } = projectsDir({
      s: [
        user("tell me about threshold tuning"),
        assistant([text("Threshold tuning: we kept 0.85.")]),
        user("threshold again, for the eval"),
        assistant([text("The eval sweeps the threshold.")]),
        user("unrelated threshold mention"),
        assistant([text("A threshold appears here too, the answer is in this one: grid search.")]),
      ],
    });
    const old = Date.now() / 1000 - 3600;
    utimesSync(files.s!, old, old);
    const embedder = new FakeEmbedder();
    const store = new Store(":memory:", embedder.dims);
    await ingest(store, [new ClaudeCodeSource(root)]);
    await embedPending(store, embedder);
    // A fake reranker that prefers candidates mentioning "grid search".
    const seen: string[][] = [];
    const reranker = {
      id: "fake",
      score: async (_q: string, docs: string[]) => {
        seen.push(docs);
        return docs.map((d) => (d.includes("grid search") ? 1 : 0));
      },
    };
    const hits = (await search(store, embedder, "threshold", { limit: 2, reranker })).flatMap((g) => g.hits);
    expect(seen[0]).toHaveLength(3); // it saw the top 10 candidates (all 3 here), not just the limit
    expect(hits).toHaveLength(2);
    expect(hits[0]!.exchange.assistant).toContain("grid search");
    expect(hits[0]!.rerankScore).toBe(1);
  });
});
