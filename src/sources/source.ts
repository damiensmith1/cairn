import type { Exchange } from "../types.js";

/** Where reading a log file stopped, and what the next read needs to carry over. */
export interface ReadState {
  /** Byte offset to resume from: the start of the exchange still in progress, or the end of the file. */
  offset: number;
  /** End of the last emitted reply, for the next exchange's prevTail. */
  prevTail: string;
  sessionName: string | null;
}

export const initialState = (): ReadState => ({ offset: 0, prevTail: "", sessionName: null });

export interface ReadResult {
  /** Exchanges completed since the given state. */
  exchanges: Exchange[];
  /**
   * When the agent compacted a session's context (earlier turns replaced by a summary). Exchanges
   * after a session's last compaction are still in its agent's context; earlier ones aren't.
   */
  compactions: { session: string; at: string }[];
  state: ReadState;
}

/** One coding agent's session logs. The rest of cairn only sees the exchanges it produces. */
export interface Source {
  readonly id: string;
  /**
   * Bump when parsing changes what's derived from a log (files edited, commits), so stored
   * exchanges get those fields re-derived. Conversation text is never re-derived.
   */
  readonly parserVersion: string;
  /** Folders to watch for changes. */
  roots(): string[];
  /** Every log file to read. */
  locations(): Promise<string[]>;
  /**
   * Complete exchanges in `location` after `state`. An exchange is complete when the next user
   * message arrives; with `final` (the session is idle), the last one counts as complete too.
   */
  read(location: string, state: ReadState, final: boolean): Promise<ReadResult>;
}
