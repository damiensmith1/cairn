import type { Exchange } from "./types.js";

/** Target chunk size in characters (~1k tokens) and the overlap between consecutive pieces. */
export const CHUNK_CHARS = Number(process.env.CAIRN_CHUNK_CHARS ?? 4000);
export const OVERLAP_CHARS = Math.round(CHUNK_CHARS * 0.15);

/** A short header from the exchange's own metadata, so a chunk keeps its meaning out of context. */
export function header(x: Pick<Exchange, "project" | "session" | "sessionName" | "at" | "files" | "commits">): string {
  const lines = [`project: ${x.project} · session: ${x.sessionName ?? x.session.slice(0, 8)} · ${x.at.slice(0, 10)}`];
  if (x.files.length) lines.push(`files: ${x.files.slice(0, 5).join(" · ")}`);
  if (x.commits.length) lines.push(`commit: ${x.commits.slice(0, 2).join(" · ")}`);
  return `${lines.join("\n")}\n---\n`;
}

/** Splits `text` into pieces of at most `size` chars, overlapping by `overlap`, cutting at whitespace when it can. */
export function split(text: string, size = CHUNK_CHARS, overlap = OVERLAP_CHARS): string[] {
  if (text.length <= size) return [text];
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > end - 200 && space > start) end = space;
    }
    pieces.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return pieces;
}

/** The texts to embed for an exchange: header + previous-reply tail + the exchange, split if long. */
export function chunkTexts(x: Exchange): string[] {
  const body =
    (x.prevTail ? `[previous reply, end] …${x.prevTail}\n` : "") + `[user] ${x.user}\n[assistant] ${x.assistant}`;
  const head = header(x);
  return split(body).map((piece) => head + piece);
}
