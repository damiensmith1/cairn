import type { Exchange } from "./types.js";

export type PointerKind = "file" | "commit" | "url" | "pr";
export type PointerRelation = "mentions" | "edited";

/** A reference from an exchange to something outside the conversation. */
export interface Pointer {
  kind: PointerKind;
  target: string;
  relation: PointerRelation;
}

/** Bump when extraction changes, so stored pointers are re-extracted. */
export const POINTERS_VERSION = "v1";

const CODE_EXT = "ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rb|rs|swift|kt|java|c|h|cpp|css|scss|html|yml|yaml|toml|sql|sh|lock|txt";
const PATH = new RegExp(`(?:~|\\.{1,2})?(?:/?[\\w@.-]+/)+[\\w@.-]+\\.(?:${CODE_EXT})\\b|\\b[\\w-]+\\.(?:${CODE_EXT})\\b`, "g");
const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/g;
const HEX = /(?<![\w-])[0-9a-f]{7,40}(?![\w-])/g;
const PR = /\b(?:PR|pull request|issue)\s*#?(\d{1,6})\b|\/pull\/(\d{1,6})\b/gi;

const trimEnd = (s: string) => s.replace(/[.,:;!?)\]}>'"`*]+$/, "");

/** A path as stored: relative to the exchange's working directory when it's inside it. */
export function normalizePath(path: string, cwd: string): string {
  let p = trimEnd(path).replace(/:\d+(?::\d+)?$/, "");
  if (cwd && p.startsWith(`${cwd}/`)) p = p.slice(cwd.length + 1);
  return p.replace(/^\.\//, "");
}

/** Every file, commit, URL and PR an exchange edits or mentions. Deterministic; no model. */
export function extractPointers(x: Pick<Exchange, "user" | "assistant" | "files" | "cwd">): Pointer[] {
  const out = new Map<string, Pointer>();
  const add = (p: Pointer) => out.set(`${p.kind}\0${p.target}\0${p.relation}`, p);
  for (const f of x.files) add({ kind: "file", target: normalizePath(f, x.cwd), relation: "edited" });

  const text = `${x.user}\n${x.assistant}`;
  const urls = text.match(URL_RE) ?? [];
  for (const u of urls) add({ kind: "url", target: trimEnd(u), relation: "mentions" });
  // Paths inside URLs are part of the URL, not files of their own.
  const rest = urls.reduce((t, u) => t.replace(u, " "), text);
  for (const m of rest.match(PATH) ?? []) {
    const target = normalizePath(m, x.cwd);
    if (target.length > 2 && !/^\d+\.\d+/.test(target)) add({ kind: "file", target, relation: "mentions" });
  }
  // Hex runs that look like commit SHAs: at least one letter and one digit, not part of a UUID.
  for (const m of rest.match(HEX) ?? []) {
    if (/[a-f]/.test(m) && /\d/.test(m)) add({ kind: "commit", target: m, relation: "mentions" });
  }
  for (const m of text.matchAll(PR)) add({ kind: "pr", target: `#${m[1] ?? m[2]}`, relation: "mentions" });
  return [...out.values()];
}

/** How a `refs` query matches stored targets. */
export function refQuery(input: string): { kind?: PointerKind; exact: string; like: string } {
  const q = input.trim();
  if (/^https?:\/\//.test(q)) return { kind: "url", exact: trimEnd(q), like: `${trimEnd(q)}%` };
  const pr = /^(?:pr\s*)?#(\d+)$/i.exec(q) ?? /^pr\s*(\d+)$/i.exec(q);
  if (pr) return { kind: "pr", exact: `#${pr[1]}`, like: `#${pr[1]}` };
  if (/^[0-9a-f]{7,40}$/.test(q)) return { kind: "commit", exact: q, like: `${q}%` };
  // Files match by path suffix: "jev.ts" finds "src/match/jev.ts".
  return { kind: "file", exact: q.replace(/^\.\//, ""), like: `%/${q.replace(/^\.\//, "")}` };
}
