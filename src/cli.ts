#!/usr/bin/env node
import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { OllamaEmbedder } from "./embed.js";
import { embedPending, ingest } from "./ingest.js";
import { claudeProjectsDir, dbPath } from "./paths.js";
import { search } from "./search.js";
import type { SessionGroup } from "./search.js";
import { ClaudeCodeSource } from "./sources/claude-code.js";
import { Store } from "./store.js";

const USAGE = `cairn: searchable memory for agent sessions

  cairn index [--no-embed] [--limit N]   read new session logs, then embed what's new
  cairn search <query> [--project P] [--since YYYY-MM-DD] [--limit N]
  cairn status                           what's stored and indexed
`;

const tty = process.stdout.isTTY;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [dim, bold, cyan] = [paint(2), paint(1), paint(36)];
const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function open() {
  const embedder = new OllamaEmbedder();
  return { embedder, store: new Store(dbPath(), embedder.dims), sources: [new ClaudeCodeSource(claudeProjectsDir())] };
}

async function index(args: string[]) {
  const { values } = parseArgs({ args, options: { "no-embed": { type: "boolean" }, limit: { type: "string" } } });
  const { embedder, store, sources } = open();
  try {
    const started = Date.now();
    const r = await ingest(store, sources);
    console.log(`read ${r.changed} of ${r.files} logs, ${bold(String(r.appended))} new exchanges ${dim(`(${Date.now() - started} ms)`)}`);
    if (values["no-embed"]) return;
    const problem = await embedder.problem();
    if (problem) {
      console.error(problem);
      process.exitCode = 1;
      return;
    }
    const t = Date.now();
    const p = await embedPending(store, embedder, {
      limit: values.limit ? Number(values.limit) : undefined,
      onProgress: ({ done, total, chunks }) => {
        const rate = chunks / ((Date.now() - t) / 1000);
        const eta = rate > 0 ? Math.round(((total - done) * (chunks / done)) / rate / 60) : 0;
        if (tty) process.stdout.write(`\rembedding ${done}/${total} exchanges, ${chunks} chunks, ${rate.toFixed(1)}/s, ~${eta} min left   `);
      },
    });
    if (tty && p.total) process.stdout.write("\n");
    console.log(`embedded ${p.done} exchanges (${p.chunks} chunks) ${dim(`in ${Math.round((Date.now() - t) / 1000)} s`)}`);
  } finally {
    store.close();
  }
}

function print(groups: SessionGroup[]) {
  if (groups.length === 0) {
    console.log("No matches.");
    return;
  }
  for (const g of groups) {
    const first = g.hits[0]!.exchange;
    console.log(`\n${bold(cyan(g.project))} · ${bold(g.sessionName ?? g.session.slice(0, 8))} ${dim(`· ${first.at.slice(0, 10)} · ${g.session}`)}`);
    for (const h of g.hits) {
      const x = h.exchange;
      console.log(`  ${dim(`${x.at.slice(0, 16).replace("T", " ")} [${h.via.join("+")}]`)}`);
      console.log(`  you    ${oneLine(x.user, 160)}`);
      console.log(`  match  ${dim(oneLine(h.snippet, 280))}`);
      console.log(`  ${dim(`${x.location}:${x.offset}`)}`);
    }
  }
}

async function find(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { project: { type: "string" }, since: { type: "string" }, limit: { type: "string" } },
  });
  const query = positionals.join(" ").trim();
  if (!query) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const { embedder, store } = open();
  try {
    const problem = await embedder.problem();
    if (problem) {
      console.error(problem);
      process.exitCode = 1;
      return;
    }
    print(
      await search(store, embedder, query, {
        ...(values.project ? { project: values.project } : {}),
        ...(values.since ? { since: values.since } : {}),
        limit: values.limit ? Number(values.limit) : 10,
      }),
    );
  } finally {
    store.close();
  }
}

async function status() {
  const { embedder, store } = open();
  try {
    const s = store.stats(embedder.id);
    const size = (statSync(dbPath()).size / 1e6).toFixed(1);
    console.log(`store      ${dbPath()} (${size} MB)`);
    console.log(`exchanges  ${s.exchanges} in ${s.sessions} sessions`);
    console.log(`embedded   ${s.embedded} exchanges, ${s.chunks} chunks (${embedder.id})`);
    console.log(`ollama     ${(await embedder.problem()) ?? "ready"}`);
  } finally {
    store.close();
  }
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<void>> = { index, search: find, status };
const run = command ? commands[command] : undefined;
if (!run) {
  console.log(USAGE);
  process.exitCode = command ? 1 : 0;
} else {
  await run(rest);
}
