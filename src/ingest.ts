import { stat } from "node:fs/promises";
import { chunkTexts } from "./chunk.js";
import { extractPointers, POINTERS_VERSION } from "./pointers.js";
import type { Embedder } from "./embed.js";
import { initialState } from "./sources/source.js";
import type { Source } from "./sources/source.js";
import type { Store } from "./store.js";

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
async function reparseIfNeeded(store: Store, source: Source): Promise<number> {
  const key = `parser:${source.id}`;
  if (store.meta(key) === source.parserVersion) return 0;
  let changed = 0;
  const empty = !store.db.prepare("SELECT 1 FROM exchanges WHERE source = ? LIMIT 1").get(source.id);
  if (!empty) {
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
  store.setMeta(key, source.parserVersion);
  return changed;
}

/**
 * Reads what's new in every log of every source and appends the complete exchanges. Idempotent:
 * cursors skip what was read, and the store ignores exchanges it already holds.
 */
export async function ingest(store: Store, sources: Source[], now = Date.now()): Promise<IngestResult> {
  const result: IngestResult = { files: 0, changed: 0, appended: 0, reparsed: 0 };
  for (const source of sources) {
    result.reparsed += await reparseIfNeeded(store, source);
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
}

/**
 * Embeds every stored exchange that has no vectors for this embedder yet. Resumable: progress is
 * committed per batch, so stopping loses at most one batch.
 */
export async function embedPending(
  store: Store,
  embedder: Embedder,
  options: { batch?: number; limit?: number; onProgress?: (p: EmbedProgress) => void } = {},
): Promise<EmbedProgress> {
  const batch = options.batch ?? 8;
  const total = Math.min(store.countUnembedded(embedder.id), options.limit ?? Infinity);
  const progress: EmbedProgress = { done: 0, total, chunks: 0 };
  while (progress.done < total) {
    const exchanges = store.unembedded(embedder.id, Math.min(batch, total - progress.done));
    if (exchanges.length === 0) break;
    const pieces = exchanges.flatMap((x) => chunkTexts(x).map((text, part) => ({ seq: x.seq, part, text })));
    const vectors = await embedder.embed(pieces.map((p) => p.text), "document");
    store.addChunks(embedder.id, pieces.map((p, i) => ({ ...p, vector: vectors[i]! })));
    progress.done += exchanges.length;
    progress.chunks += pieces.length;
    options.onProgress?.(progress);
  }
  return progress;
}
