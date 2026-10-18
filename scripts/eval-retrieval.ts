/**
 * Retrieval eval: does search find the exchange (and session) a realistic question is about?
 *
 *   npm run eval:retrieval -- sample   pick target exchanges, write views for question writers
 *   npm run eval:retrieval -- run      score search configurations against the written questions
 *
 * Data lives outside the repo, in ~/.cairn/evals/retrieval/, since it's the author's conversations.
 * Questions are written by an LLM from each target (questions_*.jsonl) and checked blind
 * (checks.jsonl); see docs/experiments.md.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OllamaEmbedder } from "../src/embed.js";
import type { Embedder } from "../src/embed.js";
import { loadLabelModel } from "../src/labels.js";
import { cairnHome, dbPath } from "../src/paths.js";
import { search, toFtsQuery } from "../src/search.js";
import type { Intent, SearchOptions } from "../src/search.js";
import { contentKey, Store } from "../src/store.js";
import type { StoredExchange } from "../src/types.js";

// The eval set stays put when CAIRN_HOME points at an experimental store.
const dir = process.env.CAIRN_EVAL_DIR ?? join(homedir(), ".cairn", "evals", "retrieval");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const jsonl = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const write = (file: string, rows: unknown[]) => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });

const embedder = new OllamaEmbedder();
const store = new Store(dbPath(), embedder.dims);

/** Seeded shuffle (mulberry32), so a sample is reproducible. */
function shuffle<T>(items: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function sample(n = 150, batches = 3) {
  // Exchanges the label probes were trained on would let the boost score on what it has seen.
  const spike = join(cairnHome(), "spikes", "decisions", "windows.jsonl");
  const trained = new Set<string>();
  for (const w of jsonl(spike) as { session: string; text: string }[]) {
    const user = w.text.split("[user] ")[1]?.split("\n[assistant reply, start]")[0]?.trim() ?? "";
    trained.add(`${w.session}\0${user.slice(0, 200)}`);
  }
  const all = store.db.prepare("SELECT * FROM exchanges WHERE length(assistant) >= 150 ORDER BY seq").all() as Record<string, any>[];
  const seen = new Set<string>();
  const pool = all.filter((r) => {
    const key = contentKey(r as never);
    if (seen.has(key)) return false; // one copy of forked exchanges
    seen.add(key);
    return !trained.has(`${r.session}\0${String(r.user).slice(0, 200)}`);
  });
  const targets = shuffle(pool, 17).slice(0, n);
  write(join(dir, "targets.jsonl"), targets.map((r, i) => ({ id: `T${String(i).padStart(3, "0")}`, seq: r.seq, session: r.session })));
  const per = Math.ceil(n / batches);
  for (let b = 0; b < batches; b++) {
    const view = targets
      .slice(b * per, (b + 1) * per)
      .map((r, i) => {
        const id = `T${String(b * per + i).padStart(3, "0")}`;
        const a = String(r.assistant);
        return `## ${id}\n(date ${String(r.at).slice(0, 10)})\n[earlier, end of previous reply] …${String(r.prev_tail).slice(-300)}\n[user] ${String(r.user).slice(0, 1500)}\n[assistant] ${a.slice(0, 2500)}${a.length > 2500 ? "…" : ""}\n`;
      })
      .join("\n---\n\n");
    writeFileSync(join(dir, `targets_view_${b}.md`), view, { mode: 0o600 });
  }
  console.log(`pool ${pool.length} exchanges (after excluding ${trained.size} trained-on and fork copies); wrote ${targets.length} targets in ${batches} views to ${dir}`);
}

interface Question {
  id: string;
  question: string;
  intent: Intent;
}

/** A retrieval configuration under test: returns exchanges best first. */
export interface Config {
  name: string;
  run(q: Question): Promise<StoredExchange[]>;
}

interface Row {
  id: string;
  intent: string;
  half: "tune" | "test";
  exRank: number;
  sessRank: number;
}

/** Checked questions with their targets. Each lands in the tune or test half by its target's session. */
function loadQuestions() {
  const targets = new Map((jsonl(join(dir, "targets.jsonl")) as { id: string; seq: number; session: string }[]).map((t) => [t.id, t]));
  const questions: Question[] = [0, 1, 2].flatMap((b) => jsonl(join(dir, `questions_${b}.jsonl`)));
  const checks = new Map((jsonl(join(dir, "checks.jsonl")) as { id: string; answers: string }[]).map((c) => [c.id, c.answers]));
  const kept = questions.filter((q) => targets.has(q.id) && (checks.size === 0 || checks.get(q.id) === "yes"));
  const half = (session: string): "tune" | "test" =>
    createHash("md5").update(session).digest()[0]! % 2 === 0 ? "tune" : "test";
  return { kept, targets, half, total: questions.length };
}

const neighbourCache = new Map<string, number[]>();
/** A hit is the target itself, a fork copy of it, or its immediate neighbour in the same session. */
function near(x: StoredExchange, target: StoredExchange) {
  if (contentKey(x) === contentKey(target)) return true;
  if (x.session !== target.session) return false;
  if (!neighbourCache.has(target.session)) {
    neighbourCache.set(
      target.session,
      store.db.prepare("SELECT seq FROM exchanges WHERE session = ? ORDER BY at").all(target.session).map((r) => (r as { seq: number }).seq),
    );
  }
  const seqs = neighbourCache.get(target.session)!;
  const i = seqs.indexOf(target.seq);
  return [seqs[i - 1], seqs[i + 1]].includes(x.seq);
}

async function evaluate(config: Config): Promise<Row[]> {
  const { kept, targets, half } = loadQuestions();
  const rows: Row[] = [];
  for (const q of kept) {
    const t = targets.get(q.id)!;
    const target = store.exchanges([t.seq])[0]!;
    const results = await config.run(q);
    const exRank = results.findIndex((x) => near(x, target));
    const sessions = [...new Set(results.map((x) => x.session))];
    const sessRank = sessions.findIndex((s) => s === target.session || results.some((x) => x.session === s && contentKey(x) === contentKey(target)));
    rows.push({ id: q.id, intent: q.intent, half: half(t.session), exRank, sessRank });
  }
  return rows;
}

function summarise(rs: Row[]) {
  const n = rs.length || 1;
  return {
    n: rs.length,
    "R@1": rs.filter((r) => r.exRank === 0).length / n,
    "R@5": rs.filter((r) => r.exRank >= 0 && r.exRank < 5).length / n,
    "R@10": rs.filter((r) => r.exRank >= 0 && r.exRank < 10).length / n,
    MRR: rs.reduce((s, r) => s + (r.exRank >= 0 ? 1 / (r.exRank + 1) : 0), 0) / n,
    "sess R@5": rs.filter((r) => r.sessRank >= 0 && r.sessRank < 5).length / n,
  };
}

const flatten = (groups: Awaited<ReturnType<typeof search>>) => groups.flatMap((g) => g.hits.map((h) => h.exchange));
const byRank = (seqs: number[], k: number) => {
  const xs = new Map(store.exchanges(seqs.slice(0, k)).map((x) => [x.seq, x]));
  return seqs.slice(0, k).map((s) => xs.get(s)!).filter(Boolean);
};
const labels = loadLabelModel(join(homedir(), ".cairn", "models", "labels.json"));
const hybrid = (name: string, opts: SearchOptions = {}, embed: Embedder = embedder): Config => ({
  name,
  run: async (q) => flatten(await search(store, embed, q.question, { limit: 10, ...opts })),
});
const boosted = (name: string, opts: SearchOptions = {}): Config => ({
  name,
  run: async (q) => flatten(await search(store, embedder, q.question, { limit: 10, intent: q.intent, ...(labels ? { labels } : {}), ...opts })),
});
/** Embeds queries without Qwen3's task instruction. */
const plainQueries: Embedder = { id: embedder.id, dims: embedder.dims, embed: (texts) => embedder.embed(texts, "document") };

const baseline: Config[] = [
  { name: "keyword only", run: async (q) => byRank(store.keyword(toFtsQuery(q.question), 50).map((m) => m.seq), 10) },
  { name: "vector only", run: async (q) => byRank(store.nearest((await embedder.embed([q.question], "query"))[0]!, 50).map((m) => m.seq), 10) },
  hybrid("hybrid"),
  boosted("hybrid + label boost"),
];

const experiments: Config[] = [
  hybrid("hybrid (pool 50, k 60)"),
  hybrid("pool 150", { pool: 150 }),
  hybrid("pool 300", { pool: 300 }),
  hybrid("rrf k 20", { rrfK: 20 }),
  hybrid("rrf k 120", { rrfK: 120 }),
  hybrid("weights kw 1 : vec 2", { weights: [1, 2] }),
  hybrid("weights kw 2 : vec 1", { weights: [2, 1] }),
  hybrid("no query instruction", {}, plainQueries),
  boosted("boost multiply 1.0"),
  boosted("boost multiply 0.3", { boost: 0.3 }),
  boosted("boost percentile 0.3", { boostMode: "percentile", boost: 0.3 }),
  boosted("boost confident 1.0", { boostMode: "confident" }),
];

function table(results: { name: string; rows: Row[] }[], split: boolean) {
  const f = (x: number) => x.toFixed(2).padStart(7);
  const head = ["R@1", "R@5", "R@10", "MRR", "sess5"];
  if (split) {
    console.log(`\n${"config".padEnd(28)} ${"── tune ──────────────────────".padEnd(36)} ${"── test ──────────────────────"}`);
    console.log(`${"".padEnd(28)} ${head.map((h) => h.padStart(7)).join("")} ${head.map((h) => h.padStart(7)).join("")}`);
  } else console.log(`\n${"config".padEnd(28)} ${head.map((h) => h.padStart(7)).join("")}`);
  for (const { name, rows } of results) {
    const cells = (rs: Row[]) => {
      const m = summarise(rs);
      return [m["R@1"], m["R@5"], m["R@10"], m.MRR, m["sess R@5"]].map(f).join("");
    };
    console.log(`${name.padEnd(28)} ${split ? `${cells(rows.filter((r) => r.half === "tune"))} ${cells(rows.filter((r) => r.half === "test"))}` : cells(rows)}`);
  }
}

async function runConfigs(configs: Config[], split: boolean, tag: string) {
  const { kept, total, half, targets } = loadQuestions();
  const tune = kept.filter((q) => half(targets.get(q.id)!.session) === "tune").length;
  console.log(`${total} questions, ${kept.length} kept after the blind check (${tune} tune, ${kept.length - tune} test); store ${dbPath()}`);
  const results: { name: string; rows: Row[] }[] = [];
  for (const c of configs) results.push({ name: c.name, rows: await evaluate(c) });
  table(results, split);
  const out = join(dir, `results-${tag}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.json`);
  writeFileSync(
    out,
    JSON.stringify(results.map(({ name, rows }) => ({ name, all: summarise(rows), tune: summarise(rows.filter((r) => r.half === "tune")), test: summarise(rows.filter((r) => r.half === "test")), byIntent: Object.fromEntries(["decision", "open", "recall"].map((i) => [i, summarise(rows.filter((r) => r.intent === i))])) })), null, 2),
    { mode: 0o600 },
  );
  console.log(`\nwrote ${out}`);
  return results;
}

/** Candidates for the reranker experiment: hybrid's top 30 per question (pool 150), as text. */
async function dumpRerank() {
  const { kept } = loadQuestions();
  const rows = [];
  for (const q of kept) {
    const hits = (await search(store, embedder, q.question, { limit: 30, pool: 150 })).flatMap((g) => g.hits);
    rows.push({
      id: q.id,
      query: q.question,
      candidates: hits.map((h) => ({ seq: h.exchange.seq, text: `${h.exchange.user}\n${h.exchange.assistant}`.slice(0, 1500) })),
    });
  }
  write(join(dir, "rerank_input.jsonl"), rows);
  console.log(`wrote ${rows.length} candidate lists to ${join(dir, "rerank_input.jsonl")}`);
}

/** Scores the reranker's order (rerank_output.jsonl: { id, order: seq[] }) against hybrid's. */
async function scoreRerank() {
  const input = new Map((jsonl(join(dir, "rerank_input.jsonl")) as { id: string; candidates: { seq: number }[] }[]).map((r) => [r.id, r]));
  const output = new Map((jsonl(join(dir, "rerank_output.jsonl")) as { id: string; order: number[] }[]).map((r) => [r.id, r.order]));
  await runConfigs(
    [
      { name: "hybrid top 30 (pool 150)", run: async (q) => byRank(input.get(q.id)?.candidates.map((c) => c.seq) ?? [], 10) },
      { name: "+ reranker (bge-v2-m3)", run: async (q) => byRank(output.get(q.id) ?? [], 10) },
    ],
    true,
    "rerank",
  );
}

const mode = process.argv[2];
try {
  if (mode === "sample") sample();
  else if (mode === "run") await runConfigs(baseline, false, "baseline");
  else if (mode === "experiments") await runConfigs(experiments, true, "experiments");
  else if (mode === "hybrid") await runConfigs([hybrid("hybrid")], true, "hybrid");
  else if (mode === "dump-rerank") await dumpRerank();
  else if (mode === "rerank") await scoreRerank();
  else console.log("usage: eval-retrieval sample | run | experiments | hybrid");
} finally {
  store.close();
}
