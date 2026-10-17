import { stat } from "node:fs/promises";
import { chunkTexts } from "./chunk.js";
import type { Embedder } from "./embed.js";
import type { Source } from "./sources/source.js";
import type { Store } from "./store.js";

/** A session counts as idle, and its last exchange complete, after this long without writes. */
export const IDLE_MS = 10 * 60 * 1000;

export interface IngestResult {
  files: number;
  changed: number;
  appended: number;
}

/**
 * Reads what's new in every log of every source and appends the complete exchanges. Idempotent:
 * cursors skip what was read, and the store ignores exchanges it already holds.
 */
export async function ingest(store: Store, sources: Source[], now = Date.now()): Promise<IngestResult> {
  const result: IngestResult = { files: 0, changed: 0, appended: 0 };
  for (const source of sources) {
    for (const location of await source.locations()) {
      result.files++;
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
