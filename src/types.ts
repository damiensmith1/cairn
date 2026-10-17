/** One user message and the assistant's reply up to the next user message. */
export interface Exchange {
  /** sha256 of the source, session, user entry id and text. Identical content is stored once. */
  hash: string;
  /** The source plug-in that produced it, e.g. "claude-code". */
  source: string;
  /** Project name derived from the working directory. */
  project: string;
  cwd: string;
  session: string;
  /** The session's name at the time, when the log has one. */
  sessionName: string | null;
  /** When the user message was sent (ISO 8601). */
  at: string;
  user: string;
  /** The assistant's text, without tool calls or tool output. */
  assistant: string;
  /** End of the previous reply in the session, so a bare "yes" keeps its proposal. */
  prevTail: string;
  /** Files the assistant edited in this exchange. */
  files: string[];
  /** First lines of git commit messages made in this exchange. */
  commits: string[];
  /** The log file and the byte offset of the user message, for open(). */
  location: string;
  offset: number;
}

/** A stored exchange: an Exchange plus its position in the append-only store. */
export interface StoredExchange extends Exchange {
  seq: number;
}
