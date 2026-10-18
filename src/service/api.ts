import type { EmbedProgress } from "../ingest.js";
import type { Intent, SessionGroup } from "../search.js";
import type { StoreStats } from "../store.js";
import type { StoredExchange } from "../types.js";

/**
 * What clients can ask: answered by cairnd over its socket, or by a Core in the client's own
 * process when cairnd isn't running. Everything here crosses the socket as JSON.
 */
export interface Api {
  search(req: SearchRequest): Promise<SearchResponse>;
  refs(target: string): Promise<RefRow[]>;
  related(session: string): Promise<RelatedRow[]>;
  /** An exchange by id, with its neighbours in the session. */
  open(id: number, around?: number): Promise<OpenResponse | null>;
  /** What a session was: when, where, what it changed, its key exchanges, related sessions. */
  brief(session: string): Promise<BriefResponse | null>;
  status(): Promise<StatusResponse>;
  close(): void;
}

export interface SearchRequest {
  query: string;
  project?: string;
  since?: string;
  topic?: string;
  intent?: Intent;
  limit?: number;
  /** Rerank the top candidates (default true). */
  rerank?: boolean;
}

export interface SearchResponse {
  groups: SessionGroup[];
  reranked: boolean;
  /** Why reranking was skipped, when it was asked for and failed. */
  rerankError?: string;
  /** Whether a label model is loaded (decision/unresolved boosts and topic filters need one). */
  labels: boolean;
}

export interface IndexResult {
  files: number;
  changed: number;
  appended: number;
  /** Stored exchanges whose parsed fields (files, commits) were re-derived after a parser change. */
  reparsed: number;
  linked: number;
  embedded: number;
  chunks: number;
  /** Exchanges set aside this run after failing to embed on their own. */
  failed: number;
  labelled: number;
  labels: boolean;
  /** Why embedding was skipped, e.g. Ollama isn't running. */
  embedError?: string;
}

export interface RefRow extends StoredExchange {
  relation: string;
  target: string;
  sessionName: string | null;
}

export interface RelatedRow {
  session: string;
  shared: number;
  sessionName: string | null;
}

export interface OpenResponse {
  target: number;
  session: string;
  sessionName: string | null;
  project: string;
  exchanges: StoredExchange[];
}

export interface KeyExchange {
  seq: number;
  at: string;
  user: string;
  /** Why it's key: it started or ended the session, made a commit, or likely held a decision. */
  why: ("first" | "last" | "commit" | "decision")[];
  commits: string[];
}

export interface BriefResponse {
  session: string;
  sessionName: string | null;
  project: string;
  cwd: string;
  first: string;
  last: string;
  exchanges: number;
  commits: string[];
  files: { path: string; edits: number }[];
  key: KeyExchange[];
  related: RelatedRow[];
}

export interface DaemonInfo {
  pid: number;
  startedAt: string;
  indexing: boolean;
  /** Embedding progress of the run in flight, during a backfill. */
  progress?: EmbedProgress;
  lastIndex?: { at: string; result: IndexResult };
  lastError?: string;
  reranker: "loaded" | "unloaded";
}

export interface StatusResponse {
  store: string;
  sizeMb: number;
  stats: StoreStats;
  embedder: string;
  labels: { version: string; metrics?: Record<string, number> } | null;
  /** "ready", or what's wrong with Ollama. */
  ollama: string;
  /** Present when cairnd answered. */
  daemon?: DaemonInfo;
}
