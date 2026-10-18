import type { Asker, IndexResult } from "./api.js";
import type { Core } from "./core.js";
import { EventBus } from "./events.js";
import type { CairnEvent } from "./events.js";
import { Coalescer } from "./queue.js";
import { serve } from "./rpc.js";
import { watchSources } from "./watcher.js";

export interface DaemonOptions {
  socket: string;
  debounceMs?: number;
  sweepMs?: number;
  /** Unload the reranker after this long without a search (default 10 minutes). */
  rerankerIdleMs?: number;
  log?: (line: string) => void;
}

export interface Daemon {
  /** Indexes now (shares a run already scheduled) and resolves with its result. */
  indexNow(): Promise<IndexResult>;
  /** Stops watching and serving, lets a run in flight finish, and closes the store. */
  stop(): Promise<void>;
}

/**
 * cairnd: watches the sources, keeps the store current through one queue, and answers clients
 * on the socket. Throws AlreadyRunning if another cairnd holds the socket.
 */
export async function startDaemon(core: Core, options: DaemonOptions): Promise<Daemon> {
  const log = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  const info = { pid: process.pid, startedAt: new Date().toISOString(), indexing: false, reranker: "unloaded" as const };
  core.daemon = info;
  core.rerankerIdleMs = options.rerankerIdleMs ?? 10 * 60 * 1000;
  const events = (core.events = new EventBus());

  const queue = new Coalescer(async () => {
    core.daemon!.indexing = true;
    const started = Date.now();
    events.emit({ type: "index-start" });
    try {
      const result = await core.index({}, (progress) => {
        core.daemon!.progress = progress;
        if (progress.done % 200 === 0) log(`embedding ${progress.done}/${progress.total}`);
      });
      core.daemon!.lastIndex = { at: new Date().toISOString(), result };
      delete core.daemon!.lastError;
      events.emit({ type: "index-done", ms: Date.now() - started, result });
      if (result.reparsed) log(`re-derived files and commits for ${result.reparsed} exchanges (parser update)`);
      if (result.appended || result.embedded || result.labelled) {
        log(`indexed in ${Date.now() - started} ms: ${result.appended} new exchanges, ${result.embedded} embedded, ${result.labelled} labelled`);
      }
      if (result.embedError) log(`embedding skipped: ${result.embedError}`);
      if (result.failed) log(`set aside ${result.failed} exchanges that failed to embed (cairn index --retry-failed)`);
      return result;
    } catch (e) {
      core.daemon!.lastError = e instanceof Error ? e.message : String(e);
      events.emit({ type: "index-error", message: core.daemon!.lastError });
      log(`index failed: ${core.daemon!.lastError}`);
      throw e;
    } finally {
      core.daemon!.indexing = false;
      delete core.daemon!.progress;
    }
  });
  const kick = () => void queue.trigger().catch(() => undefined);

  const server = await serve(options.socket, {
    ping: async () => "pong",
    status: () => core.status(),
    search: (p) => core.search(p),
    refs: (p: { target: string }) => core.refs(p.target),
    related: (p: { session: string }) => core.related(p.session),
    open: (p: { id: number; around?: number } & Asker) => core.open(p.id, p.around, { ...(p.client ? { client: p.client } : {}), ...(p.askingSession ? { askingSession: p.askingSession } : {}) }),
    brief: (p: { session: string }) => core.brief(p.session),
    subscribe: async (_params, connection) => {
      const { history, unsubscribe } = events.subscribe((e: CairnEvent) => connection.notify("event", e));
      connection.onClose(unsubscribe);
      return history;
    },
    trigger: async (params) => {
      const retried = (params as { retryFailed?: boolean } | undefined)?.retryFailed ? core.retryFailed() : 0;
      const busy = queue.busy;
      kick();
      return { scheduled: true, busy, retried };
    },
  });
  const roots = core.sources.flatMap((s) => s.roots());
  const onChange = (reason: "change" | "sweep", files: string[]) => {
    if (reason === "sweep") events.emit({ type: "sweep" });
    else {
      // Top-level logs only (subagent transcripts in nested folders aren't read in v1).
      const sessions = files
        .filter((f) => f.split("/").length === 2 && f.endsWith(".jsonl"))
        .map((f) => ({ file: f, session: f.split("/")[1]!.replace(/\.jsonl$/, "") }));
      const names = core.store.sessionNames(sessions.map((s) => s.session));
      if (sessions.length) events.emit({ type: "changed", files: sessions.map((s) => ({ ...s, name: names.get(s.session) ?? null })) });
    }
    kick();
  };
  const stopWatching = watchSources(roots, onChange, {
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    ...(options.sweepMs !== undefined ? { sweepMs: options.sweepMs } : {}),
  });
  log(`cairnd started (pid ${process.pid}), watching ${roots.join(", ")}`);
  events.emit({ type: "started", pid: process.pid, roots });
  kick(); // catch up on anything written while it was off

  return {
    indexNow: () => queue.trigger(),
    stop: async () => {
      events.emit({ type: "stopping" });
      stopWatching();
      await server.close();
      await queue.idle();
      core.close();
      log("cairnd stopped");
    },
  };
}
