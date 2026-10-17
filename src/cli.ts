#!/usr/bin/env node
import { statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { OllamaEmbedder } from "./embed.js";
import { embedPending, extractPending, ingest } from "./ingest.js";
import { labelPending, loadLabelModel } from "./labels.js";
import { cairnHome, claudeProjectsDir, dbPath } from "./paths.js";
import { search } from "./search.js";
import type { Intent, SessionGroup } from "./search.js";
import { ClaudeCodeSource } from "./sources/claude-code.js";
import { Store } from "./store.js";

const USAGE = `cairn: searchable memory for agent sessions

  cairn index [--no-embed] [--limit N]   read new session logs; embed, label and link what's new
  cairn search <query>                   hybrid search
  cairn decisions <query>                search, decisions first
  cairn unresolved <query>               search, open questions first
     options: --project P  --since YYYY-MM-DD  --topic T  --limit N
  cairn refs <file|sha|#pr|url>          every exchange that edited or mentioned it, oldest first
  cairn related <session>                sessions sharing the most files, commits and links
  cairn status                           what's stored and indexed
`;

const tty = process.stdout.isTTY;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [dim, bold, cyan] = [paint(2), paint(1), paint(36)];
const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const fail = (message: string) => {
  console.error(message);
  process.exitCode = 1;
};

const labelModelPath = () => join(cairnHome(), "models", "labels.json");

function open() {
  const embedder = new OllamaEmbedder();
  return {
    embedder,
    store: new Store(dbPath(), embedder.dims),
    sources: [new ClaudeCodeSource(claudeProjectsDir())],
    labels: loadLabelModel(labelModelPath()),
  };
}

async function index(args: string[]) {
  const { values } = parseArgs({ args, options: { "no-embed": { type: "boolean" }, limit: { type: "string" } } });
  const { embedder, store, sources, labels } = open();
  try {
    const started = Date.now();
    const r = await ingest(store, sources);
    console.log(`read ${r.changed} of ${r.files} logs, ${bold(String(r.appended))} new exchanges ${dim(`(${Date.now() - started} ms)`)}`);
    const linked = extractPending(store);
    if (linked) console.log(`extracted pointers from ${linked} exchanges`);
    if (values["no-embed"]) return;
    const problem = await embedder.problem();
    if (problem) return fail(problem);
    const t = Date.now();
    const p = await embedPending(store, embedder, {
      ...(values.limit ? { limit: Number(values.limit) } : {}),
      onProgress: ({ done, total, chunks }) => {
        const rate = chunks / ((Date.now() - t) / 1000);
        const eta = rate > 0 ? Math.round(((total - done) * (chunks / done)) / rate / 60) : 0;
        if (tty) process.stdout.write(`\rembedding ${done}/${total} exchanges, ${chunks} chunks, ${rate.toFixed(1)}/s, ~${eta} min left   `);
      },
    });
    if (tty && p.total) process.stdout.write("\n");
    if (p.total) console.log(`embedded ${p.done} exchanges (${p.chunks} chunks) ${dim(`in ${Math.round((Date.now() - t) / 1000)} s`)}`);
    if (labels) {
      const n = labelPending(store, labels, embedder.id);
      if (n) console.log(`labelled ${n} exchanges`);
    } else {
      console.log(dim(`no label model at ${labelModelPath()}: decision/unresolved/topic labels are off`));
    }
  } finally {
    store.close();
  }
}

function print(groups: SessionGroup[]) {
  if (groups.length === 0) return console.log("No matches.");
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

const searchAs = (intent?: Intent) => async (args: string[]) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { project: { type: "string" }, since: { type: "string" }, topic: { type: "string" }, limit: { type: "string" } },
  });
  const query = positionals.join(" ").trim();
  if (!query) return fail(USAGE);
  const { embedder, store, labels } = open();
  try {
    const problem = await embedder.problem();
    if (problem) return fail(problem);
    if ((intent === "decision" || intent === "open" || values.topic) && !labels) {
      console.log(dim(`no label model at ${labelModelPath()}: showing plain search`));
    }
    print(
      await search(store, embedder, query, {
        ...(values.project ? { project: values.project } : {}),
        ...(values.since ? { since: values.since } : {}),
        ...(values.topic ? { topic: values.topic } : {}),
        ...(intent ? { intent } : {}),
        ...(labels ? { labels } : {}),
        limit: values.limit ? Number(values.limit) : 10,
      }),
    );
  } finally {
    store.close();
  }
};

async function refs(args: string[]) {
  const target = args.join(" ").trim();
  if (!target) return fail(USAGE);
  const { store } = open();
  try {
    const rows = store.refs(target);
    if (rows.length === 0) return console.log("No exchanges point at that.");
    const names = store.sessionNames([...new Set(rows.map((r) => r.session))]);
    for (const x of rows) {
      console.log(`${dim(x.at.slice(0, 16).replace("T", " "))} ${bold(x.relation)} ${x.target} ${dim(`· ${x.project} · ${names.get(x.session) ?? x.session.slice(0, 8)}`)}`);
      console.log(`  you  ${oneLine(x.user, 160)}`);
    }
  } finally {
    store.close();
  }
}

async function related(args: string[]) {
  const session = args[0];
  if (!session) return fail(USAGE);
  const { store } = open();
  try {
    const rows = store.relatedSessions(session);
    if (rows.length === 0) return console.log("No sessions share files, commits or links with that one.");
    const names = store.sessionNames(rows.map((r) => r.session));
    for (const r of rows) console.log(`${String(r.shared).padStart(4)} shared  ${names.get(r.session) ?? "(unnamed)"} ${dim(r.session)}`);
  } finally {
    store.close();
  }
}

async function status() {
  const { embedder, store, labels } = open();
  try {
    const s = store.stats(embedder.id, labels?.version);
    const size = (statSync(dbPath()).size / 1e6).toFixed(1);
    console.log(`store      ${dbPath()} (${size} MB)`);
    console.log(`exchanges  ${s.exchanges} in ${s.sessions} sessions`);
    console.log(`embedded   ${s.embedded} exchanges, ${s.chunks} chunks (${embedder.id})`);
    console.log(`pointers   ${s.pointers} from ${s.linked} exchanges`);
    const quality = labels?.metrics ? ` (cv: ${Object.entries(labels.metrics).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")})` : "";
    console.log(`labels     ${labels ? `${s.labelled} exchanges, model ${labels.version}${quality}` : "off: no label model"}`);
    console.log(`ollama     ${(await embedder.problem()) ?? "ready"}`);
  } finally {
    store.close();
  }
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<void>> = {
  index,
  search: searchAs(),
  decisions: searchAs("decision"),
  unresolved: searchAs("open"),
  refs,
  related,
  status,
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.log(USAGE);
  process.exitCode = command ? 1 : 0;
} else {
  await run(rest);
}
