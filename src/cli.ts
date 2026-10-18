#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ask, explainAskError } from "./ask.js";
import { keyStore } from "./credentials.js";
import { runLive } from "./live.js";
import { labelModelPath, logDir, socketPath } from "./paths.js";
import type { Intent, SessionGroup } from "./search.js";
import type { Api } from "./service/api.js";
import { Core } from "./service/core.js";
import { startDaemon } from "./service/daemon.js";
import { isLoaded, plistPath, startService, uninstall } from "./service/launchd.js";
import { AlreadyRunning, connect, RemoteApi } from "./service/rpc.js";

const USAGE = `cairn: searchable memory for agent sessions

  cairn search <query>                   hybrid search, top 10 reranked
  cairn decisions <query>                search, decisions first
  cairn unresolved <query>               search, open questions first
     options: --project P  --since YYYY-MM-DD  --topic T  --limit N
              --no-rerank  skip reordering the top 10 with the cross-encoder (faster, worse ranking)
  cairn open <#id> [--around N] [--full] an exchange from the results, with its neighbours
  cairn brief <session|#id>              what a session was: dates, commits, files, key exchanges
  cairn ask <question>                   an answer from your sessions, with citations (Claude Haiku)
  cairn refs <file|sha|#pr|url>          every exchange that edited or mentioned it, oldest first
  cairn related <session>                sessions sharing the most files, commits and links
  cairn status                           what's stored and indexed, and whether cairnd is running
  cairn index [--no-embed] [--limit N]   catch up now (asks cairnd if it's running)
     --retry-failed                      also retry exchanges set aside after failing to embed

  cairn init [--check]                   set up: Ollama, models, sessions, API key, cairnd, backfill
                                         resumable: re-run it after a crash or Ctrl-C; --check only reports
  cairn key set|remove|status            the Anthropic API key cairn ask uses (kept in the macOS Keychain)

  cairn live                             watch cairnd work: status and activity as it happens
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
  const { values } = parseArgs({ args, options: { "no-embed": { type: "boolean" }, limit: { type: "string" }, "retry-failed": { type: "boolean" } } });
  const retryFailed = Boolean(values["retry-failed"]);
  const daemon = await remote();
  if (daemon) {
    try {
      const { busy, retried } = await daemon.trigger({ retryFailed });
      if (retryFailed) console.log(`${retried} set-aside exchanges queued to embed again.`);
      console.log(busy ? "cairnd is already indexing; it will catch up again when done." : "cairnd is indexing in the background.");
      console.log(dim("`cairn status` shows progress."));
    } finally {
      daemon.close();
    }
    return;
  }
  const core = Core.open();
  try {
    if (retryFailed) console.log(`${core.retryFailed()} set-aside exchanges queued to embed again.`);
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
    if (r.reparsed) console.log(`re-derived files and commits for ${r.reparsed} exchanges (parser update)`);
    if (r.linked) console.log(`extracted pointers from ${r.linked} exchanges`);
    if (r.embedError) return fail(r.embedError);
    if (r.embedded) console.log(`embedded ${r.embedded} exchanges (${r.chunks} chunks) ${dim(`in ${Math.round((Date.now() - t) / 1000)} s`)}`);
    if (r.failed) console.log(`set aside ${r.failed} exchanges that wouldn't embed ${dim("(cairn index --retry-failed tries them again)")}`);
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
      console.log(`  ${bold(`#${x.seq}`)} ${dim(`${x.at.slice(0, 16).replace("T", " ")} [${h.via.join("+")}${h.rerankScore !== undefined ? ", reranked" : ""}]`)}`);
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

const when = (iso: string) => iso.slice(0, 16).replace("T", " ");
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}${dim(` … (${s.length - max} more characters, --full)`)}` : s);

async function open(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { around: { type: "string" }, full: { type: "boolean" } },
  });
  const id = Number(positionals[0]?.replace(/^#/, ""));
  if (!Number.isInteger(id)) return fail(USAGE);
  const a = await api();
  try {
    const res = await a.open(id, values.around ? Number(values.around) : 2);
    if (!res) return fail(`No exchange #${id}.`);
    console.log(`${bold(cyan(res.project))} · ${bold(res.sessionName ?? res.session.slice(0, 8))} ${dim(`· ${res.session}`)}`);
    const max = values.full ? Infinity : 1500;
    for (const x of res.exchanges) {
      const here = x.seq === res.target;
      console.log(`\n${here ? bold(`▶ #${x.seq}`) : dim(`  #${x.seq}`)} ${dim(when(x.at))}`);
      console.log(`${bold("you")}     ${clip(x.user, max)}`);
      if (x.assistant) console.log(`${bold("claude")}  ${here ? clip(x.assistant, max) : dim(clip(x.assistant, Math.min(max, 400)))}`);
    }
  } finally {
    a.close();
  }
}

async function brief(args: string[]) {
  const input = args[0];
  if (!input) return fail(USAGE);
  const a = await api();
  try {
    const b = await a.brief(input);
    if (!b) return fail(`No session matches "${input}".`);
    console.log(`${bold(b.sessionName ?? "(unnamed session)")} ${dim(`· ${b.session}`)}`);
    console.log(`${cyan(b.project)} ${dim(b.cwd)}`);
    console.log(`${when(b.first)} → ${when(b.last)} · ${b.exchanges} exchanges`);
    if (b.commits.length) {
      console.log(`\n${bold("commits")}`);
      for (const c of b.commits) console.log(`  ${c}`);
    }
    if (b.files.length) {
      console.log(`\n${bold("files edited")}`);
      for (const f of b.files) console.log(`  ${f.path} ${dim(`×${f.edits}`)}`);
    }
    console.log(`\n${bold("key exchanges")}`);
    for (const k of b.key) {
      console.log(`  ${bold(`#${k.seq}`)} ${dim(`${when(k.at)} · ${k.why.join(", ")}`)}`);
      console.log(`    ${oneLine(k.user, 150)}`);
      for (const c of k.commits) console.log(dim(`    commit: ${c}`));
    }
    if (b.related.length) {
      console.log(`\n${bold("related sessions")}`);
      for (const r of b.related) console.log(`  ${r.sessionName ?? "(unnamed)"} ${dim(`· ${r.shared} shared · ${r.session}`)}`);
    }
  } finally {
    a.close();
  }
}

async function askCommand(args: string[]) {
  const question = args.join(" ").trim();
  if (!question) return fail(USAGE);
  const a = await api();
  try {
    const { passages, stopReason } = await ask(a, question, (t) => process.stdout.write(t));
    if (passages.length === 0) return console.log("No passages matched; nothing to answer from.");
    process.stdout.write("\n");
    if (stopReason === "refusal") console.log(dim("(the model declined to answer)"));
    console.log(`\n${dim("sources:")}`);
    for (const p of passages) console.log(dim(`  #${p.id} ${p.label}`));
    console.log(dim("cairn open <#id> shows one in full."));
  } catch (e) {
    fail(explainAskError(e));
  } finally {
    a.close();
  }
}

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
    if (s.stats.failed) console.log(`           ${s.stats.failed} set aside after failing to embed ${dim("(cairn index --retry-failed)")}`);
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
    try {
      const file = await startService(logFile(), socketPath(), connect);
      console.log(`cairnd is running, and will start at every login.\n${dim(`${file}\nlogs: ${logFile()}`)}`);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    return;
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

async function init(args: string[]) {
  const { values } = parseArgs({ args, options: { check: { type: "boolean" } } });
  // Loaded only here: the prompts and the Anthropic SDK would slow every other command's start.
  const { runInit } = await import("./init.js");
  if (!(await runInit({ check: Boolean(values.check) }))) process.exitCode = 1;
}

async function key([sub]: string[]) {
  const store = keyStore();
  const env = Boolean(process.env.ANTHROPIC_API_KEY);
  if (sub === "set") {
    const { runKeySet } = await import("./init.js");
    if (!(await runKeySet())) process.exitCode = 1;
    return;
  }
  if (sub === "remove") {
    const had = Boolean(store.get());
    store.delete();
    console.log(had ? `Removed the key from the ${store.where}.` : `No key stored in the ${store.where}.`);
    if (env) console.log(dim("ANTHROPIC_API_KEY is still set in your environment; cairn ask uses it."));
    return;
  }
  if (sub === "status") {
    const stored = Boolean(store.get());
    if (env) console.log(`cairn ask uses ANTHROPIC_API_KEY${stored ? ` (over the key in the ${store.where})` : ""}.`);
    else if (stored) console.log(`cairn ask uses the key in the ${store.where}.`);
    else console.log("No key: cairn ask needs one. Run cairn key set, or set ANTHROPIC_API_KEY.");
    return;
  }
  fail(USAGE);
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<void>> = {
  init,
  key,
  index,
  search: searchAs(),
  decisions: searchAs("decision"),
  unresolved: searchAs("open"),
  open,
  brief,
  ask: askCommand,
  refs,
  related,
  status,
  daemon,
  service,
  live: () => runLive(),
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.log(USAGE);
  process.exitCode = command ? 1 : 0;
} else {
  await run(rest);
}
