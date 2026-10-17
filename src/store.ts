import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { initialState } from "./sources/source.js";
import type { ReadState } from "./sources/source.js";
import type { Exchange, StoredExchange } from "./types.js";

export interface Cursor {
  state: ReadState;
  size: number;
  mtimeMs: number;
}

export interface StoreStats {
  exchanges: number;
  sessions: number;
  embedded: number;
  chunks: number;
}

interface Row {
  seq: number;
  hash: string;
  source: string;
  project: string;
  cwd: string;
  session: string;
  session_name: string | null;
  at: string;
  user: string;
  assistant: string;
  prev_tail: string;
  files: string;
  commits: string;
  location: string;
  offset: number;
}

const fromRow = (r: Row): StoredExchange => ({
  seq: r.seq,
  hash: r.hash,
  source: r.source,
  project: r.project,
  cwd: r.cwd,
  session: r.session,
  sessionName: r.session_name,
  at: r.at,
  user: r.user,
  assistant: r.assistant,
  prevTail: r.prev_tail,
  files: JSON.parse(r.files),
  commits: JSON.parse(r.commits),
  location: r.location,
  offset: r.offset,
});

/**
 * Identifies an exchange by what it says and when, regardless of session: a forked or resumed
 * session copies earlier exchanges verbatim, and those copies share this key.
 */
export const contentKey = (x: Pick<Exchange, "at" | "user" | "assistant">) =>
  createHash("sha256").update(`${x.at}\0${x.user}\0${x.assistant}`).digest("hex");

/** A search result's position in one ranked list, with the text that matched. */
export interface Match {
  seq: number;
  snippet: string;
}

/**
 * What keyword search sees for an exchange: the conversation in `text`, everything else in `meta`.
 * Both are searched; snippets come from `text` only, so they show conversation, not file lists.
 */
const ftsColumns = (x: Pick<Exchange, "user" | "assistant" | "project" | "sessionName" | "files" | "commits">) => ({
  text: `${x.user}\n${x.assistant}`,
  meta: [x.project, x.sessionName ?? "", ...x.files, ...x.commits].join("\n"),
});

/**
 * One SQLite file: the append-only exchange store, plus indexes derived from it (keyword search
 * and vectors) that can be rebuilt. Exchanges are only ever inserted, never updated or deleted.
 */
export class Store {
  readonly db: Database.Database;

  constructor(file: string, readonly dims: number) {
    if (file !== ":memory:") {
      // The store holds whole conversations, which can include pasted secrets: owner-only.
      const dir = dirname(file);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      closeSync(openSync(file, "a", 0o600));
      chmodSync(file, 0o600);
    }
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    sqliteVec.load(this.db);
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exchanges (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL, project TEXT NOT NULL, cwd TEXT NOT NULL,
        session TEXT NOT NULL, session_name TEXT, at TEXT NOT NULL,
        user TEXT NOT NULL, assistant TEXT NOT NULL, prev_tail TEXT NOT NULL,
        files TEXT NOT NULL, commits TEXT NOT NULL,
        location TEXT NOT NULL, offset INTEGER NOT NULL,
        content_key TEXT
      );
      CREATE INDEX IF NOT EXISTS exchanges_session ON exchanges(session, at);
      CREATE INDEX IF NOT EXISTS exchanges_project ON exchanges(project, at);
      CREATE TABLE IF NOT EXISTS cursors (
        location TEXT PRIMARY KEY, state TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(text, meta, tokenize = "porter unicode61 tokenchars '_'");
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exchange_seq INTEGER NOT NULL, part INTEGER NOT NULL, model TEXT NOT NULL, text TEXT NOT NULL,
        UNIQUE (exchange_seq, part, model)
      );
      CREATE INDEX IF NOT EXISTS chunks_exchange ON chunks(exchange_seq);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(embedding float[${this.dims}] distance_metric=cosine);
    `);
    // Stores built before content_key existed: add and fill it once.
    const columns = this.db.prepare("PRAGMA table_info(exchanges)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "content_key")) {
      this.db.exec("ALTER TABLE exchanges ADD COLUMN content_key TEXT");
      const rows = this.db.prepare("SELECT seq, at, user, assistant FROM exchanges").all() as Pick<Row, "seq" | "at" | "user" | "assistant">[];
      const set = this.db.prepare("UPDATE exchanges SET content_key = ? WHERE seq = ?");
      this.db.transaction(() => rows.forEach((r) => set.run(contentKey(r), r.seq)))();
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS exchanges_content ON exchanges(content_key)");
    // Stores built when the keyword index had one column: rebuild it with conversation and meta apart.
    const ftsColumnNames = this.db.prepare("PRAGMA table_info(exchanges_fts)").all() as { name: string }[];
    if (!ftsColumnNames.some((c) => c.name === "meta")) this.rebuildKeywordIndex();
    const stored = this.meta("dims");
    if (stored && Number(stored) !== this.dims) {
      throw new Error(`This store holds ${stored}-dim vectors but the embedder makes ${this.dims}. Run: cairn rebuild vectors`);
    }
    this.setMeta("dims", String(this.dims));
  }

  meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Rebuilds the keyword index from the store. It's derived data: nothing is lost. */
  rebuildKeywordIndex() {
    const rows = this.db.prepare("SELECT * FROM exchanges").all() as Row[];
    this.db.transaction(() => {
      this.db.exec(`DROP TABLE IF EXISTS exchanges_fts;
        CREATE VIRTUAL TABLE exchanges_fts USING fts5(text, meta, tokenize = "porter unicode61 tokenchars '_'");`);
      const insert = this.db.prepare("INSERT INTO exchanges_fts (rowid, text, meta) VALUES (@seq, @text, @meta)");
      for (const r of rows) insert.run({ seq: r.seq, ...ftsColumns(fromRow(r)) });
    })();
  }

  /**
   * Appends exchanges not already stored. Skips copies of an exchange already held from another
   * session (a fork or resume), so they aren't stored or embedded twice. Returns how many were new.
   */
  append(exchanges: Exchange[]): number {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO exchanges
        (hash, source, project, cwd, session, session_name, at, user, assistant, prev_tail, files, commits, location, offset, content_key)
      VALUES (@hash, @source, @project, @cwd, @session, @sessionName, @at, @user, @assistant, @prevTail, @files, @commits, @location, @offset, @contentKey)
    `);
    const copy = this.db.prepare("SELECT 1 FROM exchanges WHERE content_key = ? LIMIT 1");
    const fts = this.db.prepare("INSERT INTO exchanges_fts (rowid, text, meta) VALUES (@seq, @text, @meta)");
    let added = 0;
    this.db.transaction(() => {
      for (const x of exchanges) {
        const key = contentKey(x);
        if (copy.get(key)) continue;
        const info = insert.run({ ...x, files: JSON.stringify(x.files), commits: JSON.stringify(x.commits), contentKey: key });
        if (info.changes === 0) continue;
        fts.run({ seq: info.lastInsertRowid, ...ftsColumns(x) });
        added++;
      }
    })();
    return added;
  }

  cursor(location: string): Cursor {
    const row = this.db.prepare("SELECT state, size, mtime_ms FROM cursors WHERE location = ?").get(location) as
      | { state: string; size: number; mtime_ms: number }
      | undefined;
    return row ? { state: JSON.parse(row.state), size: row.size, mtimeMs: row.mtime_ms } : { state: initialState(), size: -1, mtimeMs: 0 };
  }

  setCursor(location: string, cursor: Cursor) {
    this.db
      .prepare(`INSERT INTO cursors (location, state, size, mtime_ms) VALUES (?, ?, ?, ?)
                ON CONFLICT(location) DO UPDATE SET state = excluded.state, size = excluded.size, mtime_ms = excluded.mtime_ms`)
      .run(location, JSON.stringify(cursor.state), cursor.size, cursor.mtimeMs);
  }

  /** Stored exchanges that have no chunks yet for `model`, oldest first. */
  unembedded(model: string, limit: number): StoredExchange[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM exchanges e
         WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.exchange_seq = e.seq AND c.model = ?)
         ORDER BY e.seq LIMIT ?`,
      )
      .all(model, limit) as Row[];
    return rows.map(fromRow);
  }

  countUnembedded(model: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) n FROM exchanges e WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.exchange_seq = e.seq AND c.model = ?)`)
        .get(model) as { n: number }
    ).n;
  }

  /** Stores an exchange's chunks and their vectors together. */
  addChunks(model: string, chunks: { seq: number; part: number; text: string; vector: Float32Array }[]) {
    const insert = this.db.prepare("INSERT OR IGNORE INTO chunks (exchange_seq, part, model, text) VALUES (?, ?, ?, ?)");
    const vector = this.db.prepare("INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)");
    this.db.transaction(() => {
      for (const c of chunks) {
        const info = insert.run(c.seq, c.part, model, c.text);
        if (info.changes === 0) continue;
        // sqlite-vec needs an integer rowid: better-sqlite3 binds plain numbers as REAL.
        vector.run(BigInt(info.lastInsertRowid), Buffer.from(c.vector.buffer, c.vector.byteOffset, c.vector.byteLength));
      }
    })();
  }

  /** Keyword search, best first, with the fragment that matched. `match` is an FTS5 query. */
  keyword(match: string, limit: number): Match[] {
    if (!match) return [];
    return this.db
      .prepare(
        `SELECT rowid seq, snippet(exchanges_fts, 0, '«', '»', '…', 24) snippet FROM exchanges_fts
         WHERE exchanges_fts MATCH ? ORDER BY bm25(exchanges_fts) LIMIT ?`,
      )
      .all(match, limit) as Match[];
  }

  /** Vector search, best first by each exchange's closest chunk, with that chunk's text (header removed). */
  nearest(vector: Float32Array, limit: number): Match[] {
    const k = Math.max(1, Math.floor(limit * 3));
    const rows = this.db
      .prepare(
        `WITH knn AS (SELECT rowid, distance FROM chunk_vectors WHERE embedding MATCH ? AND k = ${k})
         SELECT c.exchange_seq seq, c.text text FROM knn JOIN chunks c ON c.id = knn.rowid ORDER BY knn.distance`,
      )
      .all(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)) as { seq: number; text: string }[];
    const out = new Map<number, Match>();
    for (const r of rows) {
      if (!out.has(r.seq)) out.set(r.seq, { seq: r.seq, snippet: r.text.slice(r.text.indexOf("\n---\n") + 5) });
      if (out.size >= limit) break;
    }
    return [...out.values()];
  }

  exchanges(seqs: number[]): StoredExchange[] {
    if (seqs.length === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM exchanges WHERE seq IN (${seqs.map(() => "?").join(",")})`).all(...seqs) as Row[];
    return rows.map(fromRow);
  }

  /** The latest name each session was given. */
  sessionNames(sessions: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const s of sessions) {
      const row = this.db
        .prepare("SELECT session_name FROM exchanges WHERE session = ? AND session_name IS NOT NULL ORDER BY seq DESC LIMIT 1")
        .get(s) as { session_name: string } | undefined;
      if (row) out.set(s, row.session_name);
    }
    return out;
  }

  stats(model: string): StoreStats {
    const one = (sql: string, ...args: unknown[]) => (this.db.prepare(sql).get(...args) as { n: number }).n;
    return {
      exchanges: one("SELECT COUNT(*) n FROM exchanges"),
      sessions: one("SELECT COUNT(DISTINCT session) n FROM exchanges"),
      embedded: one("SELECT COUNT(DISTINCT exchange_seq) n FROM chunks WHERE model = ?", model),
      chunks: one("SELECT COUNT(*) n FROM chunks WHERE model = ?", model),
    };
  }

  close() {
    this.db.close();
  }
}
