import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Logger, type LogEntry, type Transport } from "plainlog";
import { SmartFileTransport } from "plainlog/transports/node";
import { logDir } from "./paths.js";
import { maskSecrets } from "./secrets.js";

/**
 * What cairn was asked, and which results were opened afterwards: `~/.cairn/logs/usage.jsonl`.
 * It shows the user their past queries (`cairn history`), and a search followed by an `open` of
 * one of its results is a free signal of which result helped, the start of an eval built from real
 * questions. Queries are masked for secrets before they're written; the file is owner-only.
 */

/** Who asked: the CLI, an agent through MCP, or `cairn ask` (which searches before answering). */
export type Client = "cli" | "mcp" | "ask";

export interface SearchUsage {
  query: string;
  client: Client | "unknown";
  /** The Claude Code session asking, when an agent asked from inside one. */
  session?: string;
  sessionName?: string;
  /** Result ids in the order shown. */
  hits: number[];
  ms: number;
}

export interface OpenUsage {
  id: number;
  client: Client | "unknown";
  session?: string;
  sessionName?: string;
}

export const usagePath = () => join(logDir(), "usage.jsonl");

/** String fields of an entry, masked: queries can contain pasted keys. */
const maskMeta = (meta: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, typeof v === "string" ? maskSecrets(v) : v]));

export class UsageLog {
  private readonly logger = new Logger("info");

  /** Writes JSON lines to `file`, or to `transport` (tests). */
  constructor(file = usagePath(), transport?: Transport) {
    if (!transport) {
      // The folder must exist (plainlog doesn't create it), and the file is owner-only.
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
      chmodSync(file, 0o600);
    }
    this.logger.use(transport ?? new SmartFileTransport(() => basename(file), dirname(file)));
    this.logger.setSanitizer(maskMeta);
    // A failed write loses one line; it must never affect a search.
    this.logger.setErrorHandler(() => {});
  }

  search(e: SearchUsage) {
    this.logger.info("search", { ...e });
  }

  open(e: OpenUsage) {
    this.logger.info("open", { ...e });
  }

  flush() {
    return this.logger.flush();
  }
}

/** The log's entries, oldest first; unreadable lines are skipped. */
export function readUsage(file = usagePath()): LogEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogEntry];
      } catch {
        return [];
      }
    });
}

export interface HistoryRow extends SearchUsage {
  at: string;
  /** Results of this search that the same asker opened before searching again. */
  opened: number[];
}

/**
 * Searches, each with the results opened after it: an `open` belongs to the latest search by the
 * same asker (same session, or the same client when there's no session) that returned that id.
 */
export function history(entries: LogEntry[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const latest = new Map<string, HistoryRow>();
  const asker = (m: { client: string; session?: string }) => m.session ?? `client:${m.client}`;
  for (const e of entries) {
    const m = e.meta as (SearchUsage & OpenUsage) | undefined;
    if (!m) continue;
    if (e.message === "search") {
      const row: HistoryRow = { ...m, at: e.timestamp, opened: [] };
      rows.push(row);
      latest.set(asker(m), row);
    } else if (e.message === "open") {
      const row = latest.get(asker(m));
      if (row && row.hits.includes(m.id) && !row.opened.includes(m.id)) row.opened.push(m.id);
    }
  }
  return rows;
}
