import type { Embedder } from "./embed.js";
import type { LabelModel } from "./labels.js";
import { contentKey } from "./store.js";
import type { Match, Store } from "./store.js";
import type { StoredExchange } from "./types.js";

/** Reciprocal rank fusion constant: dampens how much the very top of one list dominates. */
export const RRF_K = 60;

const STOPWORDS = new Set(
  "a an and are as at be but by did do does for from had has have how i if in is it its me my of on or so that the their them then there this to us was we were what when where which who why will with you your".split(
    " ",
  ),
);

/** A plain-language query as an FTS5 query: its meaningful words, any of which may match. */
export function toFtsQuery(query: string): string {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const kept = [...new Set(words.filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
  return kept.map((w) => `"${w}"`).join(" OR ");
}

/** Merges ranked lists: each item scores the sum of 1 / (RRF_K + rank) over the lists it appears in. */
export function fuse(lists: number[][]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
  }
  return scores;
}

/** What the question is after; decides which label boosts. See the query layer in docs/design.md. */
export type Intent = "decision" | "open" | "recall" | "find_session" | "refs";

/** How much a label can raise a result: a score is multiplied by up to (1 + LABEL_BOOST). */
export const LABEL_BOOST = 1;

export interface SearchOptions {
  limit?: number;
  project?: string;
  /** ISO date; only exchanges at or after it. */
  since?: string;
  intent?: Intent;
  /** Only exchanges whose labelled topic is this. Needs a label model. */
  topic?: string;
  /** The label model whose stored labels boost and filter; without one, labels are ignored. */
  labels?: LabelModel;
}

export interface Hit {
  exchange: StoredExchange;
  score: number;
  via: ("keyword" | "vector")[];
  /** The part that matched: a keyword fragment, or the start of the closest chunk. */
  snippet: string;
}

export interface SessionGroup {
  session: string;
  sessionName: string | null;
  project: string;
  hits: Hit[];
}

/** Hybrid search: keyword ∪ vector, fused, filtered, grouped by session. Returns verbatim exchanges. */
export async function search(store: Store, embedder: Embedder, query: string, options: SearchOptions = {}): Promise<SessionGroup[]> {
  const limit = options.limit ?? 10;
  const pool = Math.max(50, limit * 5);
  const keyword = store.keyword(toFtsQuery(query), pool);
  const [vector] = await embedder.embed([query], "query");
  const nearest = store.nearest(vector!, pool);
  const scores = fuse([keyword.map((m) => m.seq), nearest.map((m) => m.seq)]);
  // Labels re-rank: a decision question lifts exchanges likely to hold a decision, an open
  // question lifts unresolved ones.
  const labels = options.labels ? store.labels([...scores.keys()], options.labels.version) : new Map();
  if (options.intent === "decision" || options.intent === "open") {
    for (const [seq, score] of scores) {
      const l = labels.get(seq);
      if (l) scores.set(seq, score * (1 + LABEL_BOOST * (options.intent === "decision" ? l.pDecision : l.pUnresolved)));
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([seq]) => seq);
  const bySeq = new Map(store.exchanges(ranked).map((x) => [x.seq, x]));

  const byKeyword = new Map(keyword.map((m): [number, Match] => [m.seq, m]));
  const byVector = new Map(nearest.map((m): [number, Match] => [m.seq, m]));
  const seen = new Set<string>();
  const hits: Hit[] = [];
  for (const seq of ranked) {
    const x = bySeq.get(seq);
    if (!x) continue;
    if (options.project && x.project !== options.project) continue;
    if (options.since && x.at < options.since) continue;
    if (options.topic && labels.get(seq)?.topic !== options.topic) continue;
    // Forked and resumed sessions copy earlier exchanges: show each once.
    const key = contentKey(x);
    if (seen.has(key)) continue;
    seen.add(key);
    const via: Hit["via"] = [];
    if (byKeyword.has(seq)) via.push("keyword");
    if (byVector.has(seq)) via.push("vector");
    // A keyword fragment only helps if the match is in the conversation (it carries «markers»);
    // a match in file names or the project shows nothing useful, so use the closest chunk instead.
    const fragment = byKeyword.get(seq)?.snippet;
    const snippet = (fragment?.includes("«") ? fragment : undefined) ?? byVector.get(seq)?.snippet ?? fragment ?? x.assistant;
    hits.push({ exchange: x, score: scores.get(seq)!, via, snippet });
    if (hits.length >= limit) break;
  }

  const names = store.sessionNames([...new Set(hits.map((h) => h.exchange.session))]);
  const groups = new Map<string, SessionGroup>();
  for (const h of hits) {
    const s = h.exchange.session;
    if (!groups.has(s)) groups.set(s, { session: s, sessionName: names.get(s) ?? null, project: h.exchange.project, hits: [] });
    groups.get(s)!.hits.push(h);
  }
  return [...groups.values()];
}
