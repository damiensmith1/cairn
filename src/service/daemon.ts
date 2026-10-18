import type { IndexResult } from "./api.js";
import type { Core } from "./core.js";
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

  const queue = new Coalescer(async () => {
    core.daemon!.indexing = true;
    try {
      const result = await core.index({}, (progress) => {
        core.daemon!.progress = progress;
        if (progress.done % 200 === 0) log(`embedding ${progress.done}/${progress.total}`);
      });
      core.daemon!.lastIndex = { at: new Date().toISOString(), result };
      delete core.daemon!.lastError;
      if (result.appended || result.embedded || result.labelled) {
        log(`indexed: ${result.appended} new exchanges, ${result.embedded} embedded, ${result.labelled} labelled`);
      }
      if (result.embedError) log(`embedding skipped: ${result.embedError}`);
      return result;
    } catch (e) {
      core.daemon!.lastError = e instanceof Error ? e.message : String(e);
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
    trigger: async () => {
      const busy = queue.busy;
      kick();
      return { scheduled: true, busy };
    },
  });
  const roots = core.sources.flatMap((s) => s.roots());
  const stopWatching = watchSources(roots, kick, {
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    ...(options.sweepMs !== undefined ? { sweepMs: options.sweepMs } : {}),
  });
  log(`cairnd started (pid ${process.pid}), watching ${roots.join(", ")}`);
  kick(); // catch up on anything written while it was off

  return {
    indexNow: () => queue.trigger(),
    stop: async () => {
      stopWatching();
      await server.close();
      await queue.idle();
      core.close();
      log("cairnd stopped");
    },
  };
}
