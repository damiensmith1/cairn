import { utimesSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { embedPending, extractPending, ingest } from "../src/ingest.js";
import { auc, labelPending, predictBinary, trainBinary, trainMulticlass } from "../src/labels.js";
import type { LabelModel } from "../src/labels.js";
import { extractPointers, normalizePath, refQuery } from "../src/pointers.js";
import { search } from "../src/search.js";
import { ClaudeCodeSource } from "../src/sources/claude-code.js";
import { Store } from "../src/store.js";
import { assistant, FakeEmbedder, projectsDir, text, toolUse, user } from "./helpers.js";

describe("extractPointers", () => {
  const x = (u: string, a = "", files: string[] = []) => ({ user: u, assistant: a, files, cwd: "/r/llm-cassette" });

  it("finds files, commits, URLs and PRs; edited files are marked as such", () => {
    const ps = extractPointers(
      x("look at src/match/jev.ts and PR #12", "Committed as d75556c, see https://github.com/x/y/pull/14.", ["/r/llm-cassette/src/store.ts"]),
    );
    const has = (kind: string, target: string, relation = "mentions") =>
      ps.some((p) => p.kind === kind && p.target === target && p.relation === relation);
    expect(has("file", "src/store.ts", "edited")).toBe(true);
    expect(has("file", "src/match/jev.ts")).toBe(true);
    expect(has("commit", "d75556c")).toBe(true);
    expect(has("url", "https://github.com/x/y/pull/14")).toBe(true);
    expect(has("pr", "#12")).toBe(true);
    expect(has("pr", "#14")).toBe(true);
  });

  it("doesn't mistake UUID pieces, version numbers or URL paths for pointers", () => {
    const ps = extractPointers(x("session 485c5181-3e45-4331-b4d1-f502e5ad9c94 on v0.2.0", "see https://example.com/docs/guide.md"));
    expect(ps.filter((p) => p.kind === "commit")).toEqual([]);
    expect(ps.filter((p) => p.kind === "file")).toEqual([]);
  });

  it("stores paths relative to the working directory", () => {
    expect(normalizePath("/r/llm-cassette/src/a.ts:12", "/r/llm-cassette")).toBe("src/a.ts");
    expect(normalizePath("./docs/design.md.", "/r/x")).toBe("docs/design.md");
  });

  it("reads refs queries", () => {
    expect(refQuery("jev.ts")).toMatchObject({ kind: "file", like: "%/jev.ts" });
    expect(refQuery("PR #12")).toMatchObject({ kind: "pr", exact: "#12" });
    expect(refQuery("d75556c")).toMatchObject({ kind: "commit" });
    expect(refQuery("https://a.b/c")).toMatchObject({ kind: "url" });
  });
});

describe("label probes", () => {
  // Two separable clusters in 4 dimensions.
  const X = Array.from({ length: 80 }, (_, i) => {
    const pos = i % 2 === 0;
    return Float32Array.from([pos ? 1 : -1, pos ? 0.5 : -0.5, Math.sin(i), Math.cos(i)].map((v) => v + 0.1 * Math.sin(i * 7)));
  });
  const y = X.map((_, i) => i % 2 === 0);

  it("trains a binary probe that separates its classes", () => {
    const probe = trainBinary(X, y);
    const scores = X.map((x) => predictBinary(probe, x));
    expect(auc(scores, y)).toBe(1);
  });

  it("trains a multiclass probe", () => {
    const labels = X.map((x) => (x[0]! > 0 ? "design" : "debugging"));
    const probe = trainMulticlass(X, labels);
    expect(probe.classes).toEqual(["debugging", "design"]);
  });
});

describe("enrichment in the store", () => {
  async function setup() {
    const { root, files } = projectsDir({
      a: [
        user("why is jev.ts slow?", { cwd: "/r/cassette" }),
        assistant([text("Batching fixes it."), toolUse("Edit", { file_path: "/r/cassette/src/match/jev.ts" })]),
        user("ok, let's go with batching", { cwd: "/r/cassette" }),
        assistant([text("Done.")]),
      ],
      b: [user("remember the jev.ts change?", { cwd: "/r/cassette" }), assistant([text("Yes, src/match/jev.ts batches now.")])],
      c: [user("unrelated question about css", { cwd: "/r/site" }), assistant([text("Use grid.")])],
    });
    const old = Date.now() / 1000 - 3600;
    for (const f of Object.values(files)) utimesSync(f, old, old);
    const embedder = new FakeEmbedder();
    const store = new Store(":memory:", embedder.dims);
    await ingest(store, [new ClaudeCodeSource(root)]);
    return { store, embedder };
  }

  it("extracts pointers once, answers refs oldest first, and links related sessions", async () => {
    const { store } = await setup();
    expect(extractPending(store)).toBe(4);
    expect(extractPending(store)).toBe(0);
    const rows = store.refs("jev.ts");
    expect(rows.map((r) => r.session)).toEqual(["a", "b"]);
    expect(rows[0]!.relation).toBeDefined();
    // Both forms are shared: the bare "jev.ts" and the full "src/match/jev.ts".
    expect(store.relatedSessions("a")[0]).toEqual({ session: "b", shared: 2 });
    expect(store.relatedSessions("a").map((r) => r.session)).not.toContain("c");
  });

  it("labels embedded exchanges and filters search by topic", async () => {
    const { store, embedder } = await setup();
    await embedPending(store, embedder);
    // A toy model: "decision" probability rises along one direction of the fake embedding.
    const [dir] = await embedder.embed(["lets go with batching"]);
    const model: LabelModel = {
      version: "test-1",
      embedder: embedder.id,
      dims: embedder.dims,
      decision: { type: "binary", coef: Array.from(dir!, (v) => v * 20), intercept: -2 },
      unresolved: { type: "binary", coef: new Array(embedder.dims).fill(0), intercept: 0 },
      topic: { type: "multiclass", classes: ["building", "design"], coef: [new Array(embedder.dims).fill(0), new Array(embedder.dims).fill(0)], intercept: [0, 0] },
    };
    expect(labelPending(store, model, embedder.id)).toBe(4);
    expect(labelPending(store, model, embedder.id)).toBe(0);

    const all = (await search(store, embedder, "batching jev")).flatMap((g) => g.hits);
    const topic = store.labels([all[0]!.exchange.seq], model.version).get(all[0]!.exchange.seq)!.topic;
    const other = model.topic.classes.find((c) => c !== topic)!;
    const only = async (t: string) => (await search(store, embedder, "batching jev", { labels: model, topic: t })).flatMap((g) => g.hits);
    expect((await only(topic)).length).toBe(all.length);
    expect(await only(other)).toHaveLength(0);
  });
});
