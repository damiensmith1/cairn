import { stat } from "node:fs/promises";
import { chunkTexts } from "./chunk.js";
import { extractPointers, POINTERS_VERSION } from "./pointers.js";
import type { Embedder } from "./embed.js";
import { initialState } from "./sources/source.js";
import type { Source } from "./sources/source.js";
import type { Store } from "./store.js";
import type { StoredExchange } from "./types.js";

/** A session counts as idle, and its last exchange complete, after this long without writes. */
export const IDLE_MS = 10 * 60 * 1000;

export interface IngestResult {
  files: number;
  changed: number;
  appended: number;
  /** Stored exchanges whose parsed fields were re-derived after a parser change. */
  reparsed: number;
}

/**
 * After a source's parser changes, re-reads all its logs and re-derives the parsed fields of
 * exchanges already stored (Store.updateParsed). Runs once per parser version; on a fresh store
 * it only records the version.
 */
async function reparseIfNeeded(store: Store, sources: Source[]): Promise<number> {
  // One source type can watch several folders: re-parse them all before recording the version.
  const [first] = sources;
  if (!first) return 0;
  const key = `parser:${first.id}`;
  if (store.meta(key) === first.parserVersion) return 0;
  let changed = 0;
  const empty = !store.db.prepare("SELECT 1 FROM exchanges WHERE source = ? LIMIT 1").get(first.id);
  if (!empty) {
    for (const source of sources) {
      for (const location of await source.locations()) {
        await new Promise((resolve) => setImmediate(resolve));
        try {
          const { exchanges } = await source.read(location, initialState(), true);
          changed += store.updateParsed(exchanges);
        } catch {
          // unreadable log: left as it was
        }
      }
    }
  }
  store.setMeta(key, first.parserVersion);
  return changed;
}

/**
 * Reads what's new in every log of every source and appends the complete exchanges. Idempotent:
 * cursors skip what was read, and the store ignores exchanges it already holds.
 */
export async function ingest(store: Store, sources: Source[], now = Date.now()): Promise<IngestResult> {
  const result: IngestResult = { files: 0, changed: 0, appended: 0, reparsed: 0 };
  for (const id of new Set(sources.map((s) => s.id))) {
    result.reparsed += await reparseIfNeeded(store, sources.filter((s) => s.id === id));
  }
  for (const source of sources) {
    for (const location of await source.locations()) {
      result.files++;
      // Let a server in the same process (cairnd) answer between files.
      await new Promise((resolve) => setImmediate(resolve));
      let info;
      try {
        info = await stat(location);
      } catch {
        continue;
      }
      const cursor = store.cursor(location);
      const idle = now - info.mtimeMs > IDLE_MS;
      const unchanged = info.size === cursor.size && info.mtimeMs === cursor.mtimeMs;
      // Nothing new, unless an exchange was left open and the session has since gone idle.
      if (unchanged && (cursor.state.offset >= info.size || !idle)) continue;
      const { exchanges, state } = await source.read(location, cursor.state, idle);
      result.appended += store.append(exchanges);
      result.changed++;
      store.setCursor(location, { state, size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  return result;
}

/** Extracts pointers for every exchange not yet processed at this extraction version. */
export function extractPending(store: Store): number {
  let n = 0;
  for (;;) {
    const exchanges = store.pending("pointers", POINTERS_VERSION, 500);
    if (exchanges.length === 0) return n;
    store.addPointers(POINTERS_VERSION, exchanges.map((x) => ({ seq: x.seq, pointers: extractPointers(x) })));
    n += exchanges.length;
  }
}

export interface EmbedProgress {
  done: number;
  total: number;
  chunks: number;
  /** Exchanges that failed to embed on their own this run. */
  failed: number;
}

/**
 * Embeds every stored exchange that has no vectors for this embedder yet. Resumable: progress is
 * committed per batch, so stopping loses at most one batch.
 */
export async function embedPending(
  store: Store,
  embedder: Embedder,
  options: {
    batch?: number;
    limit?: number;
    onProgress?: (p: EmbedProgress) => void;
    /** Waits between retries of a failed batch (default 1 s, 4 s, 15 s). */
    retryDelays?: number[];
  } = {},
): Promise<EmbedProgress> {
  const batch = options.batch ?? 8;
  const retryDelays = options.retryDelays ?? [1000, 4000, 15_000];
  const total = Math.min(store.countUnembedded(embedder.id), options.limit ?? Infinity);
  const progress: EmbedProgress = { done: 0, total, chunks: 0, failed: 0 };

  /** Embeds and stores some exchanges, retrying transient failures with backoff. */
  const embedAll = async (exchanges: StoredExchange[]) => {
    const pieces = exchanges.flatMap((x) => chunkTexts(x).map((text, part) => ({ seq: x.seq, part, text })));
    for (let attempt = 0; ; attempt++) {
      try {
        const vectors = await embedder.embed(pieces.map((p) => p.text), "document");
        store.addChunks(embedder.id, pieces.map((p, i) => ({ ...p, vector: vectors[i]! })));
        return pieces.length;
      } catch (e) {
        if (attempt >= retryDelays.length) throw e;
        await new Promise((r) => setTimeout(r, retryDelays[attempt]));
      }
    }
  };

  while (progress.done + progress.failed < total) {
    const exchanges = store.unembedded(embedder.id, Math.min(batch, total - progress.done - progress.failed));
    if (exchanges.length === 0) break;
    try {
      progress.chunks += await embedAll(exchanges);
      progress.done += exchanges.length;
    } catch (e) {
      // If the embedder itself is down (Ollama stopped, model gone), stop: the next run resumes
      // from here. Otherwise something in this batch is bad: embed one at a time and set aside
      // the ones that still fail, so they can't block the rest.
      const problem = await embedder.problem?.();
      if (problem) throw new Error(problem);
      for (const x of exchanges) {
        try {
          progress.chunks += await embedAll([x]);
          progress.done++;
        } catch (single) {
          if (await embedder.problem?.()) throw single;
          store.recordEmbedFailure(x.seq, embedder.id, single instanceof Error ? single.message : String(single));
          progress.failed++;
        }
      }
    }
    options.onProgress?.(progress);
  }
  return progress;
}
