import { statSync } from "node:fs";
import { homedir } from "node:os";
import { expandHome, loadConfig } from "../config.js";
import { OllamaEmbedder } from "../embed.js";
import type { Embedder } from "../embed.js";
import { embedPending, extractPending, ingest } from "../ingest.js";
import type { EmbedProgress } from "../ingest.js";
import { labelPending, loadLabelModel } from "../labels.js";
import type { LabelModel } from "../labels.js";
import { claudeProjectsDir, dbPath, labelModelPath } from "../paths.js";
import { OnnxReranker } from "../rerank.js";
import type { Reranker } from "../rerank.js";
import { search } from "../search.js";
import type { SearchOptions } from "../search.js";
import { ClaudeCodeSource } from "../sources/claude-code.js";
import type { Source } from "../sources/source.js";
import { Store } from "../store.js";
import { normalizePath } from "../pointers.js";
import type {
  Api,
  BriefResponse,
  DaemonInfo,
  IndexResult,
  KeyExchange,
  OpenResponse,
  RefRow,
  RelatedRow,
  SearchRequest,
  SearchResponse,
  StatusResponse,
} from "./api.js";
import type { EventBus } from "./events.js";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;

/**
 * The store, the models and every operation on them. cairnd holds one for its lifetime; the CLI
 * makes one for a single command when cairnd isn't running.
 */
export class Core implements Api {
  /** Set by cairnd, so `status` can report on it. */
  daemon?: DaemonInfo;
  /** Unload the reranker after this long without a search (cairnd sets it; one-shot CLIs don't need it). */
  rerankerIdleMs?: number;
  /** Where cairnd publishes what it's doing; one-shot CLIs leave it unset. */
  events?: EventBus;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly store: Store,
    readonly embedder: Embedder,
    readonly sources: Source[],
    readonly labels: LabelModel | undefined,
    readonly reranker: Reranker | undefined,
    readonly dbFile = ":memory:",
  ) {}

  /** The real thing: the store under ~/.cairn, Ollama embeddings, the sources in config.toml. */
  static open(): Core {
    const embedder = new OllamaEmbedder();
    const claude = loadConfig()?.sources?.["claude-code"];
    // Without a config (before `cairn init`), watch Claude Code where it writes.
    const sources = claude ? (claude.enabled ? claude.paths.map((p) => new ClaudeCodeSource(expandHome(p))) : []) : [new ClaudeCodeSource(claudeProjectsDir())];
    return new Core(
      new Store(dbPath(), embedder.dims),
      embedder,
      sources,
      loadLabelModel(labelModelPath()),
      new OnnxReranker(),
      dbPath(),
    );
  }

  /** Puts exchanges set aside after failing to embed back in the queue; returns how many. */
  retryFailed(): number {
    return this.store.clearEmbedFailures(this.embedder.id);
  }

  /** Reads what's new, then links, embeds and labels it. Safe to run any time; it only adds. */
  async index(options: { embed?: boolean; limit?: number } = {}, onProgress?: (p: EmbedProgress) => void): Promise<IndexResult> {
    const t0 = Date.now();
    const r = await ingest(this.store, this.sources);
    if (r.reparsed) this.events?.emit({ type: "reparsed", exchanges: r.reparsed, ms: Date.now() - t0 });
    if (r.changed) this.events?.emit({ type: "read", files: r.files, changed: r.changed, appended: r.appended, ms: Date.now() - t0 });
    const linked = extractPending(this.store);
    if (linked) this.events?.emit({ type: "pointers", exchanges: linked });
    const result: IndexResult = { ...r, linked, embedded: 0, chunks: 0, failed: 0, labelled: 0, labels: Boolean(this.labels) };
    if (options.embed === false) return result;
    const problem = await this.embedder.problem?.();
    if (problem) return { ...result, embedError: problem };
    const t1 = Date.now();
    const p = await embedPending(this.store, this.embedder, {
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      onProgress: (progress) => {
        onProgress?.(progress);
        this.events?.emit({ type: "embedding", ...progress });
      },
    });
    result.embedded = p.done;
    result.chunks = p.chunks;
    result.failed = p.failed;
    if (p.done) this.events?.emit({ type: "embedded", exchanges: p.done, chunks: p.chunks, ms: Date.now() - t1 });
    if (this.labels) result.labelled = labelPending(this.store, this.labels, this.embedder.id);
    if (result.labelled) this.events?.emit({ type: "labelled", exchanges: result.labelled });
    return result;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const options: SearchOptions = {
      limit: req.limit ?? 10,
      ...(req.project ? { project: req.project } : {}),
      ...(req.since ? { since: req.since } : {}),
      ...(req.topic ? { topic: req.topic } : {}),
      ...(req.askingSession ? { askingSession: req.askingSession } : {}),
      ...(this.labels ? { labels: this.labels } : {}),
    };
    const labels = Boolean(this.labels);
    const run = (o: SearchOptions) =>
      search(this.store, this.embedder, req.query, o).catch(async (e: unknown) => {
        // Name the real cause (Ollama down, model missing) instead of a fetch error.
        throw new Error((await this.embedder.problem?.()) ?? message(e));
      });
    const started = Date.now();
    const done = (res: SearchResponse) => {
      const hits = res.groups.reduce((n, g) => n + g.hits.length, 0);
      this.events?.emit({ type: "search", query: req.query, hits, reranked: res.reranked, ms: Date.now() - started });
      return res;
    };
    if (req.rerank === false || !this.reranker) return done({ groups: await run(options), reranked: false, labels });
    const wasLoaded = this.reranker.loaded;
    try {
      const groups = await run({ ...options, reranker: this.reranker });
      if (!wasLoaded && this.reranker.loaded) this.events?.emit({ type: "reranker", state: "loaded" });
      this.touchReranker();
      return done({ groups, reranked: true, labels });
    } catch (e) {
      // Reranking failed (e.g. offline before its first download): answer without it. If the
      // embedder is what failed, this throws the same error again.
      return done({ groups: await run(options), reranked: false, rerankError: message(e), labels });
    }
  }

  async refs(target: string): Promise<RefRow[]> {
    const rows = this.store.refs(target);
    const names = this.store.sessionNames([...new Set(rows.map((r) => r.session))]);
    return rows.map((r) => ({ ...r, sessionName: names.get(r.session) ?? null }));
  }

  async related(session: string): Promise<RelatedRow[]> {
    const rows = this.store.relatedSessions(session);
    const names = this.store.sessionNames(rows.map((r) => r.session));
    return rows.map((r) => ({ ...r, sessionName: names.get(r.session) ?? null }));
  }

  async open(id: number, around = 2): Promise<OpenResponse | null> {
    const exchanges = this.store.around(id, around, around);
    const target = exchanges.find((x) => x.seq === id);
    if (!target) return null;
    const name = this.store.sessionNames([target.session]).get(target.session) ?? null;
    return { target: id, session: target.session, sessionName: name, project: target.project, exchanges };
  }

  async brief(input: string): Promise<BriefResponse | null> {
    const session = this.store.resolveSession(input);
    if (!session) return null;
    const all = this.store.sessionExchanges(session);
    if (all.length === 0) return null;
    const first = all[0]!;
    const last = all.at(-1)!;

    const edits = new Map<string, number>();
    for (const x of all) for (const f of x.files) {
      // Relative to the session's folder when inside it; otherwise ~-shortened.
      const full = normalizePath(f, x.cwd);
      const path = full.startsWith(`${homedir()}/`) ? `~/${full.slice(homedir().length + 1)}` : full;
      edits.set(path, (edits.get(path) ?? 0) + 1);
    }
    const files = [...edits].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, n]) => ({ path, edits: n }));

    // Key exchanges, all quoted, never generated: where it started and ended, what it committed,
    // and the likeliest decisions (labels are weak, so only confident ones, and only a few).
    const why = new Map<number, KeyExchange["why"]>();
    const mark = (x: { seq: number }, reason: KeyExchange["why"][number]) => why.set(x.seq, [...(why.get(x.seq) ?? []), reason]);
    mark(first, "first");
    if (last !== first) mark(last, "last");
    for (const x of all.filter((e) => e.commits.length).slice(0, 8)) mark(x, "commit");
    if (this.labels) {
      const labels = this.store.labels(all.map((x) => x.seq), this.labels.version);
      all
        .map((x) => ({ x, p: labels.get(x.seq)?.pDecision ?? 0 }))
        .filter((d) => d.p >= 0.65)
        .sort((a, b) => b.p - a.p)
        .slice(0, 3)
        .forEach((d) => mark(d.x, "decision"));
    }
    const key = all
      .filter((x) => why.has(x.seq))
      .map((x) => ({ seq: x.seq, at: x.at, user: x.user, why: why.get(x.seq)!, commits: x.commits }));

    return {
      session,
      sessionName: this.store.sessionNames([session]).get(session) ?? null,
      project: first.project,
      cwd: first.cwd,
      first: first.at,
      last: last.at,
      exchanges: all.length,
      commits: [...new Set(all.flatMap((x) => x.commits))],
      files,
      key,
      related: await this.related(session),
    };
  }

  async status(): Promise<StatusResponse> {
    let sizeMb = 0;
    try {
      if (this.dbFile !== ":memory:") sizeMb = statSync(this.dbFile).size / 1e6;
    } catch {
      // not created yet
    }
    return {
      store: this.dbFile,
      sizeMb,
      stats: this.store.stats(this.embedder.id, this.labels?.version),
      embedder: this.embedder.id,
      labels: this.labels ? { version: this.labels.version, ...(this.labels.metrics ? { metrics: this.labels.metrics } : {}) } : null,
      ollama: (await this.embedder.problem?.()) ?? "ready",
      ...(this.daemon ? { daemon: { ...this.daemon, reranker: this.reranker?.loaded ? "loaded" : "unloaded" } } : {}),
    };
  }

  /** Restarts the reranker's idle countdown after a search. */
  private touchReranker() {
    if (!this.rerankerIdleMs || !this.reranker?.unload) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.reranker?.unload?.().then(() => this.events?.emit({ type: "reranker", state: "unloaded" }));
    }, this.rerankerIdleMs);
    this.idleTimer.unref();
  }

  close() {
    clearTimeout(this.idleTimer);
    void this.reranker?.unload?.();
    this.store.close();
  }
}
