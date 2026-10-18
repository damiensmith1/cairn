#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";
import { labelModelPath, logDir, socketPath } from "./paths.js";
import type { Intent, SessionGroup } from "./search.js";
import type { Api } from "./service/api.js";
import { Core } from "./service/core.js";
import { startDaemon } from "./service/daemon.js";
import { install, isLoaded, plistPath, uninstall } from "./service/launchd.js";
import { AlreadyRunning, connect, RemoteApi } from "./service/rpc.js";

const USAGE = `cairn: searchable memory for agent sessions

  cairn search <query>                   hybrid search, top 10 reranked
  cairn decisions <query>                search, decisions first
  cairn unresolved <query>               search, open questions first
     options: --project P  --since YYYY-MM-DD  --topic T  --limit N
              --no-rerank  skip reordering the top 10 with the cross-encoder (faster, worse ranking)
  cairn refs <file|sha|#pr|url>          every exchange that edited or mentioned it, oldest first
  cairn related <session>                sessions sharing the most files, commits and links
  cairn status                           what's stored and indexed, and whether cairnd is running
  cairn index [--no-embed] [--limit N]   catch up now (asks cairnd if it's running)

  cairn service start|stop|status        run cairnd in the background, at every login
  cairn daemon                           run cairnd in the foreground
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
const logFile = () => join(logDir(), "cairnd.log");

/** cairnd if it's running, else this process does the work. */
async function remote(): Promise<RemoteApi | undefined> {
  const client = await connect(socketPath());
  return client ? new RemoteApi(client) : undefined;
}
const api = async (): Promise<Api> => (await remote()) ?? Core.open();

async function index(args: string[]) {
  const { values } = parseArgs({ args, options: { "no-embed": { type: "boolean" }, limit: { type: "string" } } });
  const daemon = await remote();
  if (daemon) {
    try {
      const { busy } = await daemon.trigger();
      console.log(busy ? "cairnd is already indexing; it will catch up again when done." : "cairnd is indexing in the background.");
      console.log(dim("`cairn status` shows progress."));
    } finally {
      daemon.close();
    }
    return;
  }
  const core = Core.open();
  try {
    const t = Date.now();
    const r = await core.index(
      { ...(values["no-embed"] ? { embed: false } : {}), ...(values.limit ? { limit: Number(values.limit) } : {}) },
      ({ done, total, chunks }) => {
        const rate = chunks / ((Date.now() - t) / 1000);
        const eta = rate > 0 ? Math.round(((total - done) * (chunks / done)) / rate / 60) : 0;
        if (tty) process.stdout.write(`\rembedding ${done}/${total} exchanges, ${chunks} chunks, ${rate.toFixed(1)}/s, ~${eta} min left   `);
      },
    );
    if (tty && r.embedded) process.stdout.write("\n");
    console.log(`read ${r.changed} of ${r.files} logs, ${bold(String(r.appended))} new exchanges`);
    if (r.linked) console.log(`extracted pointers from ${r.linked} exchanges`);
    if (r.embedError) return fail(r.embedError);
    if (r.embedded) console.log(`embedded ${r.embedded} exchanges (${r.chunks} chunks) ${dim(`in ${Math.round((Date.now() - t) / 1000)} s`)}`);
    if (r.labelled) console.log(`labelled ${r.labelled} exchanges`);
    if (!r.labels && values["no-embed"] === undefined) console.log(dim(`no label model at ${labelModelPath()}: labels are off`));
  } finally {
    core.close();
  }
}

function print(groups: SessionGroup[]) {
  if (groups.length === 0) return console.log("No matches.");
  for (const g of groups) {
    const first = g.hits[0]!.exchange;
    console.log(`\n${bold(cyan(g.project))} · ${bold(g.sessionName ?? g.session.slice(0, 8))} ${dim(`· ${first.at.slice(0, 10)} · ${g.session}`)}`);
    for (const h of g.hits) {
      const x = h.exchange;
      console.log(`  ${dim(`${x.at.slice(0, 16).replace("T", " ")} [${h.via.join("+")}${h.rerankScore !== undefined ? ", reranked" : ""}]`)}`);
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
    options: {
      project: { type: "string" },
      since: { type: "string" },
      topic: { type: "string" },
      limit: { type: "string" },
      "no-rerank": { type: "boolean" },
    },
  });
  const query = positionals.join(" ").trim();
  if (!query) return fail(USAGE);
  const a = await api();
  try {
    const res = await a.search({
      query,
      ...(values.project ? { project: values.project } : {}),
      ...(values.since ? { since: values.since } : {}),
      ...(values.topic ? { topic: values.topic } : {}),
      ...(intent ? { intent } : {}),
      ...(values.limit ? { limit: Number(values.limit) } : {}),
      rerank: !values["no-rerank"],
    });
    if ((intent === "decision" || intent === "open" || values.topic) && !res.labels) {
      console.log(dim(`no label model at ${labelModelPath()}: showing plain search`));
    }
    if (res.rerankError) console.log(dim(`reranker unavailable (${res.rerankError}); showing unreranked results`));
    print(res.groups);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    a.close();
  }
};

async function refs(args: string[]) {
  const target = args.join(" ").trim();
  if (!target) return fail(USAGE);
  const a = await api();
  try {
    const rows = await a.refs(target);
    if (rows.length === 0) return console.log("No exchanges point at that.");
    for (const x of rows) {
      console.log(`${dim(x.at.slice(0, 16).replace("T", " "))} ${bold(x.relation)} ${x.target} ${dim(`· ${x.project} · ${x.sessionName ?? x.session.slice(0, 8)}`)}`);
      console.log(`  you  ${oneLine(x.user, 160)}`);
    }
  } finally {
    a.close();
  }
}

async function related(args: string[]) {
  const session = args[0];
  if (!session) return fail(USAGE);
  const a = await api();
  try {
    const rows = await a.related(session);
    if (rows.length === 0) return console.log("No sessions share files, commits or links with that one.");
    for (const r of rows) console.log(`${String(r.shared).padStart(4)} shared  ${r.sessionName ?? "(unnamed)"} ${dim(r.session)}`);
  } finally {
    a.close();
  }
}

async function status() {
  const a = await api();
  try {
    const s = await a.status();
    console.log(`store      ${s.store} (${s.sizeMb.toFixed(1)} MB)`);
    console.log(`exchanges  ${s.stats.exchanges} in ${s.stats.sessions} sessions`);
    console.log(`embedded   ${s.stats.embedded} exchanges, ${s.stats.chunks} chunks (${s.embedder})`);
    console.log(`pointers   ${s.stats.pointers} from ${s.stats.linked} exchanges`);
    const quality = s.labels?.metrics ? ` (cv: ${Object.entries(s.labels.metrics).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")})` : "";
    console.log(`labels     ${s.labels ? `${s.stats.labelled} exchanges, model ${s.labels.version}${quality}` : "off: no label model"}`);
    console.log(`ollama     ${s.ollama}`);
    const d = s.daemon;
    if (!d) return console.log(`cairnd     not running ${dim("(cairn service start)")}`);
    const up = Math.round((Date.now() - Date.parse(d.startedAt)) / 60_000);
    const doing = d.progress ? `embedding ${d.progress.done}/${d.progress.total}` : d.indexing ? "indexing" : "idle";
    console.log(`cairnd     running, pid ${d.pid}, up ${up} min, ${doing}, reranker ${d.reranker}`);
    if (d.lastIndex) console.log(dim(`           last index ${d.lastIndex.at.slice(0, 19).replace("T", " ")}: ${d.lastIndex.result.appended} new`));
    if (d.lastError) console.log(`           last error: ${d.lastError}`);
  } finally {
    a.close();
  }
}

async function daemon() {
  const core = Core.open();
  let d;
  try {
    d = await startDaemon(core, { socket: socketPath() });
  } catch (e) {
    core.close();
    if (e instanceof AlreadyRunning) return fail(e.message);
    throw e;
  }
  const stop = async () => {
    await d.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}

async function service(args: string[]) {
  const sub = args[0];
  if (sub === "start") {
    let file: string;
    try {
      file = await install(logFile());
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    // The first catch-up after an install can keep cairnd busy for a while.
    for (let i = 0; i < 60; i++) {
      const c = await connect(socketPath(), 1000);
      if (c) {
        c.close();
        console.log(`cairnd is running, and will start at every login.\n${dim(`${file}\nlogs: ${logFile()}`)}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return fail(`cairnd was installed but isn't answering yet; see ${logFile()}`);
  }
  if (sub === "stop") {
    await uninstall();
    return console.log("cairnd stopped and won't start at login. `cairn service start` brings it back.");
  }
  if (sub === "status") {
    const c = await connect(socketPath(), 500);
    c?.close();
    console.log(`installed  ${isLoaded() ? `yes (${plistPath()})` : "no"}`);
    console.log(`answering  ${c ? "yes" : "no"}`);
    console.log(dim(`logs: ${logFile()}`));
    return;
  }
  fail(USAGE);
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
  daemon,
  service,
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.log(USAGE);
  process.exitCode = command ? 1 : 0;
} else {
  await run(rest);
}
