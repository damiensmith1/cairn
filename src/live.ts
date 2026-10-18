import { socketPath } from "./paths.js";
import type { StatusResponse } from "./service/api.js";
import type { CairnEvent } from "./service/events.js";
import { connect, RemoteApi } from "./service/rpc.js";

type Tone = "dim" | "info" | "good" | "accent" | "bad";
export interface Line {
  at: string;
  kind: string;
  text: string;
  tone: Tone;
  /** Lines with the same key replace each other in place (embedding progress, a session being written). */
  key?: string;
  /** How many times this line has been updated in place. */
  count?: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line of the feed for an event, or undefined for events the header shows instead. */
export function formatEvent(e: CairnEvent): Line | undefined {
  const at = e.at;
  switch (e.type) {
    case "started":
      return { at, kind: "started", text: `pid ${e.pid} · watching ${e.roots.join(", ")}`, tone: "info" };
    case "changed":
      return { at, kind: "changed", text: e.files.map((f) => f.name ?? f.session.slice(0, 8)).join(", "), tone: "dim" };
    case "read":
      return e.appended
        ? { at, kind: "read", text: `${plural(e.appended, "new exchange")} from ${plural(e.changed, "log")} · ${e.ms} ms`, tone: "info" }
        : { at, kind: "read", text: `${plural(e.changed, "log")} · nothing complete yet (an exchange is still in progress)`, tone: "dim" };
    case "reparsed":
      return { at, kind: "reparsed", text: `re-derived files and commits for ${plural(e.exchanges, "exchange")} (parser update) · ${e.ms} ms`, tone: "info" };
    case "pointers":
      return { at, kind: "pointers", text: `linked ${plural(e.exchanges, "exchange")}`, tone: "dim" };
    case "embedding":
      return { at, kind: "embedding", text: `${e.done}/${e.total} exchanges · ${e.chunks} chunks`, tone: "info", key: "embedding" };
    case "embedded":
      return { at, kind: "embedded", text: `${plural(e.exchanges, "exchange")} · ${plural(e.chunks, "chunk")} · ${e.ms} ms`, tone: "good" };
    case "labelled":
      return { at, kind: "labelled", text: plural(e.exchanges, "exchange"), tone: "good" };
    case "index-done": {
      const r = e.result;
      if (!r.appended && !r.embedded && !r.labelled) return undefined;
      return { at, kind: "done", text: `index run took ${e.ms} ms${r.embedError ? ` · embedding skipped: ${r.embedError}` : ""}`, tone: "dim" };
    }
    case "index-error":
      return { at, kind: "error", text: e.message, tone: "bad" };
    case "search":
      return { at, kind: "search", text: `"${e.query}" · ${plural(e.hits, "hit")}${e.reranked ? " · reranked" : ""} · ${e.ms} ms`, tone: "accent" };
    case "reranker":
      return { at, kind: "reranker", text: e.state === "loaded" ? "loaded" : "unloaded (idle)", tone: "dim" };
    case "stopping":
      return { at, kind: "stopping", text: "cairnd is stopping", tone: "bad" };
    case "sweep":
    case "index-start":
      return undefined;
  }
}

/**
 * The feed: events turned into lines, with the noise folded. A session being written logs a change
 * every few seconds while its exchange is still in progress; those collapse into one line that
 * counts updates, until the exchange completes and is read.
 */
export class Feed {
  readonly lines: Line[] = [];
  /** Sessions that changed since the last read, by display name. */
  private readonly changed = new Map<string, string>();

  constructor(private readonly max = 500) {}

  /** Adds an event; returns the line it added or updated, and whether it replaced the last one. */
  push(e: CairnEvent): { line: Line; replaced: boolean } | undefined {
    if (e.type === "changed") {
      for (const f of e.files) this.changed.set(f.session, f.name ?? f.session.slice(0, 8));
      return undefined;
    }
    if (e.type === "read") {
      const names = [...this.changed.values()].join(", ") || plural(e.changed, "log");
      this.changed.clear();
      if (!e.appended) return this.put({ at: e.at, kind: "writing", text: `${names} · exchange in progress`, tone: "dim", key: `writing:${names}` }, true);
      return this.put({ at: e.at, kind: "read", text: `${plural(e.appended, "new exchange")} from ${names} · ${e.ms} ms`, tone: "info" });
    }
    if (e.type === "index-done") this.changed.clear();
    const line = formatEvent(e);
    return line ? this.put(line) : undefined;
  }

  private put(line: Line, counted = false): { line: Line; replaced: boolean } {
    const last = this.lines.at(-1);
    if (line.key && last?.key === line.key) {
      const count = (last.count ?? 1) + 1;
      const updated = counted ? { ...line, count, text: `${line.text} (${count} updates)` } : line;
      this.lines[this.lines.length - 1] = updated;
      return { line: updated, replaced: true };
    }
    const added = counted ? { ...line, count: 1 } : line;
    this.lines.push(added);
    if (this.lines.length > this.max) this.lines.shift();
    return { line: added, replaced: false };
  }
}

const TONES: Record<Tone, string> = { dim: "2", info: "36", good: "32", accent: "35", bad: "31" };
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour12: false });

/** The status header: what cairnd holds and is doing. */
export function header(s: StatusResponse | undefined, lastSweep: string | undefined): string[] {
  if (!s?.daemon) return ["cairnd: connecting…", "", ""];
  const d = s.daemon;
  const up = Math.round((Date.now() - Date.parse(d.startedAt)) / 60_000);
  const doing = d.progress ? `embedding ${d.progress.done}/${d.progress.total}` : d.indexing ? "indexing" : "idle";
  const backlog = s.stats.exchanges - s.stats.embedded;
  return [
    `cairnd · pid ${d.pid} · up ${up} min · ${doing} · ollama ${s.ollama} · reranker ${d.reranker}`,
    `store ${s.stats.exchanges.toLocaleString()} exchanges · ${s.stats.embedded.toLocaleString()} embedded · ${backlog.toLocaleString()} backlog · ${s.stats.pointers.toLocaleString()} pointers · ${s.stats.labelled.toLocaleString()} labelled`,
    `last sweep ${lastSweep ? time(lastSweep) : "—"} · last index ${d.lastIndex ? time(d.lastIndex.at) : "—"}${d.lastError ? ` · last error: ${d.lastError}` : ""}`,
  ];
}

/** `cairn live`: cairnd's status and activity, updating as it happens. */
export async function runLive(): Promise<void> {
  const out = process.stdout;
  const tty = out.isTTY;
  const color = (tone: Tone, s: string) => (tty ? `\x1b[${TONES[tone]}m${s}\x1b[0m` : s);
  let feed = new Feed();
  let status: StatusResponse | undefined;
  let lastSweep: string | undefined;
  let note = "";
  let api: RemoteApi | undefined;
  let stopped = false;

  const fit = (s: string) => (tty && s.length > out.columns ? `${s.slice(0, out.columns - 1)}…` : s);
  const show = (l: Line) => `${color("dim", time(l.at))}  ${color(l.tone, l.kind.padEnd(9))} ${l.text}`;
  // "HH:MM:SS  kind      " is 20 characters; the text gets the rest of the row.
  const feedLine = (l: Line) => {
    const room = Math.max(10, out.columns - 21);
    return show({ ...l, text: l.text.length > room ? `${l.text.slice(0, room - 1)}…` : l.text });
  };

  let pending = false;
  const render = () => {
    if (!tty || pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      const head = header(status, lastSweep).map((h, i) => (i === 0 ? color("info", fit(h)) : color("dim", fit(h))));
      const rule = color("dim", "─".repeat(Math.max(10, out.columns - 1)));
      const room = Math.max(1, out.rows - head.length - 3);
      const shown = feed.lines.slice(-room).map(feedLine);
      const footer = color("dim", fit(note || "q to quit"));
      out.write(`\x1b[H${[...head, rule, ...shown].map((l) => `${l}\x1b[K`).join("\n")}\x1b[J\x1b[${out.rows};1H${footer}\x1b[K`);
    }, 50);
  };

  const add = (e: CairnEvent) => {
    if (e.type === "sweep") lastSweep = e.at;
    const pushed = feed.push(e);
    if (tty) render();
    // Piped output can't rewrite a line, so it prints only new ones.
    else if (pushed && !pushed.replaced) console.log(show(pushed.line));
  };

  const quit = () => {
    stopped = true;
    api?.close();
    if (tty) {
      out.write("\x1b[?25h\x1b[?1049l");
      process.stdin.setRawMode?.(false);
    }
    process.exit(0);
  };
  if (tty) {
    out.write("\x1b[?1049h\x1b[?25l");
    out.on("resize", render);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (key) => {
      const k = key.toString();
      if (k === "q" || k === "\u0003") quit();
    });
  }
  process.once("SIGINT", quit);
  process.once("SIGTERM", quit);

  // Connect, subscribe, and keep the header fresh; if cairnd goes away, wait for it to come back.
  while (!stopped) {
    const client = await connect(socketPath(), 1000);
    if (!client) {
      note = "cairnd isn't running (cairn service start); waiting for it…";
      if (!tty) {
        console.error(note);
        process.exitCode = 1;
        return;
      }
      render();
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    api = new RemoteApi(client);
    note = "";
    const closed = new Promise<void>((resolve) => api!.onClose(resolve));
    const history = await api.subscribe(add);
    feed = new Feed();
    for (const e of history) add(e);
    const poll = setInterval(async () => {
      status = await api?.status().catch(() => status);
      render();
    }, 2000);
    status = await api.status().catch(() => undefined);
    render();
    await closed;
    clearInterval(poll);
    status = undefined;
    note = "cairnd disconnected; reconnecting…";
    render();
  }
}
