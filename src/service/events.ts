import type { IndexResult } from "./api.js";

/** What cairnd is doing, as it happens. `cairn live` shows these. */
export type CairnEvent =
  | { type: "started"; at: string; pid: number; roots: string[] }
  | { type: "changed"; at: string; files: { file: string; session: string; name: string | null }[] }
  | { type: "sweep"; at: string }
  | { type: "index-start"; at: string }
  | { type: "read"; at: string; files: number; changed: number; appended: number; ms: number }
  | { type: "pointers"; at: string; exchanges: number }
  | { type: "embedding"; at: string; done: number; total: number; chunks: number }
  | { type: "embedded"; at: string; exchanges: number; chunks: number; ms: number }
  | { type: "labelled"; at: string; exchanges: number }
  | { type: "index-done"; at: string; ms: number; result: IndexResult }
  | { type: "index-error"; at: string; message: string }
  | { type: "search"; at: string; query: string; hits: number; reranked: boolean; ms: number }
  | { type: "reranker"; at: string; state: "loaded" | "unloaded" }
  | { type: "stopping"; at: string };

/** A CairnEvent before it's stamped with a time. */
export type EventInput = CairnEvent extends infer E ? (E extends unknown ? Omit<E, "at"> : never) : never;

/** Fans events out to subscribers and keeps the last few for anyone who joins late. */
export class EventBus {
  private readonly listeners = new Set<(e: CairnEvent) => void>();
  private readonly recent: CairnEvent[] = [];

  constructor(private readonly keep = 200) {}

  emit(input: EventInput) {
    const event = { ...input, at: new Date().toISOString() } as CairnEvent;
    this.recent.push(event);
    if (this.recent.length > this.keep) this.recent.shift();
    for (const listener of this.listeners) listener(event);
  }

  /** Calls `listener` for every new event; returns the events so far and an unsubscribe function. */
  subscribe(listener: (e: CairnEvent) => void): { history: CairnEvent[]; unsubscribe: () => void } {
    this.listeners.add(listener);
    return { history: [...this.recent], unsubscribe: () => this.listeners.delete(listener) };
  }
}
