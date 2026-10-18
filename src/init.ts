import Anthropic from "@anthropic-ai/sdk";
import * as p from "@clack/prompts";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import { ASK_MODEL } from "./ask.js";
import { configPath, expandHome, loadConfig, saveConfig, tildify } from "./config.js";
import { anthropicKey, keyStore, looksLikeKey } from "./credentials.js";
import { DEFAULT_EMBED_MODEL } from "./embed.js";
import { hasBrew, hasModel, installOllama, ollamaInstall, ollamaRunning, pullModel, startOllama } from "./ollama.js";
import { cairnHome, claudeProjectsDir, logDir, socketPath } from "./paths.js";
import { OnnxReranker } from "./rerank.js";
import type { CairnEvent } from "./service/events.js";
import { isLoaded, nodePath, startService } from "./service/launchd.js";
import { connect, RemoteApi } from "./service/rpc.js";
import { ClaudeCodeSource } from "./sources/claude-code.js";

/**
 * `cairn init`: gets a machine ready, one step at a time. Every step checks the real state first
 * (is the model pulled, is the key in the Keychain, is the service loaded) and only fixes what's
 * missing, so after a crash, a reboot or Ctrl-C, running it again picks up where things stand.
 * The backfill itself runs in cairnd, which resumes on its own.
 */

interface Check {
  done: boolean;
  detail: string;
  /** Done only because the user chose to skip it. */
  skipped?: boolean;
}

interface Step {
  id: string;
  title: string;
  check(): Promise<Check>;
  /** Fixes what's missing. Throws a StepError to stop with a message, Paused if the user cancels. */
  run(): Promise<"done" | "skipped">;
}

class StepError extends Error {}
class Paused extends Error {}

const RERANKER = "Xenova/ms-marco-MiniLM-L-6-v2";
const logFile = () => join(logDir(), "cairnd.log");
const gb = (bytes: number) => (bytes / 2 ** 30).toFixed(1);

/** A prompt's answer, or Paused if the user pressed Ctrl-C / Esc. */
function answer<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new Paused();
  return value as Exclude<T, symbol>;
}

// ---- progress, kept so a later run can say what happened --------------------------------

interface InitState {
  steps: Record<string, { status: "done" | "skipped" | "failed" | "paused"; at: string; detail?: string }>;
}
const statePath = () => join(cairnHome(), "init.json");

function loadState(): InitState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as InitState;
  } catch {
    return { steps: {} };
  }
}

function saveState(state: InitState) {
  mkdirSync(cairnHome(), { recursive: true, mode: 0o700 });
  const tmp = `${statePath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, statePath());
}

// ---- the steps ---------------------------------------------------------------------------

function steps(options: { skipped: (id: string) => boolean }): Step[] {
  const rerankerDir = () => join(cairnHome(), "models", "transformers", RERANKER);

  return [
    {
      id: "machine",
      title: "Machine",
      async check() {
        const node = Number(process.versions.node.split(".")[0]);
        const fs = statfsSync(homedir());
        const free = fs.bavail * fs.bsize;
        const ram = totalmem();
        const warnings = [ram < 8 * 2 ** 30 ? "under 8 GB RAM, embedding will be slow" : ""].filter(Boolean);
        return {
          done: node >= 22 && free >= 2 * 2 ** 30,
          detail: `Node ${process.versions.node} · ${gb(ram)} GB RAM · ${gb(free)} GB free${warnings.length ? ` (${warnings.join("; ")})` : ""}`,
        };
      },
      async run() {
        if (Number(process.versions.node.split(".")[0]) < 22) throw new StepError("cairn needs Node 22 or newer.");
        throw new StepError("cairn needs about 2 GB of free disk for its models and store.");
      },
    },
    {
      id: "ollama",
      title: "Ollama (local embeddings)",
      async check() {
        const install = ollamaInstall();
        if (!install) return { done: false, detail: "not installed" };
        if (!(await ollamaRunning())) return { done: false, detail: "installed, not running" };
        if (!(await hasModel(DEFAULT_EMBED_MODEL))) return { done: false, detail: `running; ${DEFAULT_EMBED_MODEL} not pulled` };
        return { done: true, detail: `running · ${DEFAULT_EMBED_MODEL}` };
      },
      async run() {
        let install = ollamaInstall();
        if (!install) {
          if (!hasBrew()) throw new StepError("Ollama isn't installed. Get it from https://ollama.com/download, then run cairn init again.");
          const ok = answer(await p.confirm({ message: "Ollama isn't installed. Install it with Homebrew (brew install ollama)?" }));
          if (!ok) throw new StepError("cairn needs Ollama for local embeddings. Install it and run cairn init again.");
          if ((await installOllama()) !== 0) throw new StepError("brew install ollama failed; see its output above.");
          install = ollamaInstall();
          if (!install) throw new StepError("Ollama still isn't found after installing.");
        }
        if (!(await ollamaRunning())) {
          const s = p.spinner();
          s.start("Starting Ollama");
          if (!(await startOllama(install))) {
            s.error("Ollama didn't start");
            throw new StepError("Start Ollama yourself, then run cairn init again.");
          }
          s.stop("Ollama is running");
        }
        if (!(await hasModel(DEFAULT_EMBED_MODEL))) {
          const s = p.spinner();
          s.start(`Downloading ${DEFAULT_EMBED_MODEL}`);
          try {
            await pullModel(DEFAULT_EMBED_MODEL, (u) => {
              const pct = u.total ? ` · ${Math.floor((100 * (u.completed ?? 0)) / u.total)}% of ${Math.round(u.total / 1e6)} MB` : "";
              s.message(`Downloading ${DEFAULT_EMBED_MODEL}: ${u.status}${pct}`);
            });
          } catch (e) {
            s.error("Download failed");
            throw new StepError(`Couldn't download ${DEFAULT_EMBED_MODEL}: ${e instanceof Error ? e.message : String(e)}. Run cairn init again to resume it.`);
          }
          s.stop(`${DEFAULT_EMBED_MODEL} is ready`);
        }
        return "done";
      },
    },
    {
      id: "reranker",
      title: "Reranker",
      async check() {
        const model = join(rerankerDir(), "onnx", "model_quantized.onnx");
        const ok = ["config.json", "tokenizer.json"].every((f) => existsSync(join(rerankerDir(), f))) && existsSync(model) && statSync(model).size > 1e6;
        return { done: ok, detail: ok ? "MiniLM-L6 (int8)" : "not downloaded" };
      },
      async run() {
        const s = p.spinner();
        s.start("Fetching the reranker (~23 MB)");
        for (let attempt = 1; ; attempt++) {
          const reranker = new OnnxReranker();
          try {
            await reranker.score("warm up", ["a"]);
            await reranker.unload();
            s.stop("Reranker ready");
            return "done";
          } catch (e) {
            await reranker.unload();
            // A download cut short leaves a broken file in the cache: clear it and fetch again.
            rmSync(rerankerDir(), { recursive: true, force: true });
            if (attempt >= 2) {
              s.error("Reranker download failed");
              throw new StepError(`Couldn't fetch the reranker: ${e instanceof Error ? e.message : String(e)}. Run cairn init again to retry.`);
            }
          }
        }
      },
    },
    {
      id: "sources",
      title: "Sessions to watch",
      async check() {
        const claude = loadConfig()?.sources?.["claude-code"];
        if (!claude) return { done: false, detail: `not chosen yet (${tildify(configPath())})` };
        if (!claude.enabled) return { done: true, detail: "Claude Code: off" };
        const counts = await Promise.all(claude.paths.map(async (dir) => (await new ClaudeCodeSource(expandHome(dir)).locations()).length));
        return { done: true, detail: `Claude Code: ${claude.paths.join(", ")} · ${counts.reduce((a, b) => a + b, 0)} sessions` };
      },
      async run() {
        const detected = claudeProjectsDir();
        const found = (await new ClaudeCodeSource(detected).locations()).length;
        const watch = answer(
          await p.confirm({
            message: found ? `Watch Claude Code sessions in ${tildify(detected)} (${found} found)?` : `Watch Claude Code sessions in ${tildify(detected)}? (none there yet)`,
          }),
        );
        const paths = watch ? [detected] : [];
        for (;;) {
          const more = answer(
            await p.text({
              message: "Another folder of Claude Code sessions to watch? (leave empty to finish)",
              placeholder: "~/work-claude/projects",
              validate: (v) => (!v || existsSync(expandHome(v.trim())) ? undefined : "That folder doesn't exist."),
            }),
          );
          if (!more?.trim()) break;
          paths.push(expandHome(more.trim()));
        }
        saveConfig({ sources: { "claude-code": { enabled: paths.length > 0, paths: paths.map(tildify) } } });
        if (!paths.length) p.log.warn("No sessions chosen: cairn has nothing to index until you run cairn init again.");
        return "done";
      },
    },
    {
      id: "key",
      title: "Anthropic API key (for cairn ask)",
      async check() {
        const key = anthropicKey();
        if (key) return { done: true, detail: key.from === "ANTHROPIC_API_KEY" ? "from ANTHROPIC_API_KEY" : `in the ${key.from}` };
        if (options.skipped("key")) return { done: true, skipped: true, detail: "skipped (cairn key set adds one)" };
        return { done: false, detail: "none (ask won't work without one)" };
      },
      async run() {
        const result = await promptForKey();
        if (result === "skipped") p.log.info("Skipped. cairn key set adds one later.");
        return result;
      },
    },
    {
      id: "service",
      title: "cairnd (background indexer)",
      async check() {
        const client = isLoaded() ? await connect(socketPath(), 1000) : undefined;
        if (!client) return { done: false, detail: isLoaded() ? "installed, not answering" : "not installed" };
        const api = new RemoteApi(client);
        try {
          // Sources chosen after it started (maybe by a run that was cut short) need a restart.
          const started = Date.parse((await api.status()).daemon?.startedAt ?? "");
          if (existsSync(configPath()) && statSync(configPath()).mtimeMs > started) return { done: false, detail: "restarting to pick up the new sources" };
        } finally {
          api.close();
        }
        return { done: true, detail: "running, starts at login" };
      },
      async run() {
        const s = p.spinner();
        s.start("Starting cairnd");
        try {
          await startService(logFile(), socketPath(), connect);
        } catch (e) {
          s.error("cairnd didn't start");
          throw new StepError(e instanceof Error ? e.message : String(e));
        }
        s.stop("cairnd is running, and will start at every login");
        return "done";
      },
    },
    {
      id: "mcp",
      title: "Claude Code (MCP)",
      async check() {
        if (spawnSync("which", ["claude"], { stdio: "ignore" }).status !== 0) return { done: true, skipped: true, detail: "Claude Code's CLI isn't on the PATH; skipped" };
        // Exits 0 when a server named cairn is registered in any scope.
        if (spawnSync("claude", ["mcp", "get", "cairn"], { stdio: "ignore", timeout: 30_000 }).status === 0) return { done: true, detail: "registered: agents can search your past sessions" };
        if (options.skipped("mcp")) return { done: true, skipped: true, detail: `skipped (to add it: claude ${mcpAddArgs().join(" ")})` };
        return { done: false, detail: "not registered" };
      },
      async run() {
        const args = mcpAddArgs();
        if (!args.includes("mcp")) throw new StepError("Register from the built CLI: npm run build, then node dist/cli.js init.");
        const ok = answer(await p.confirm({ message: `Let Claude Code search your past sessions, in every project? This runs: claude ${args.join(" ")}` }));
        if (!ok) {
          p.log.info("Skipped. cairn init remembers that; the command above adds it later.");
          return "skipped";
        }
        const r = spawnSync("claude", args, { encoding: "utf8" });
        if (r.status !== 0) throw new StepError(`claude mcp add failed: ${(r.stderr || r.stdout).trim()}`);
        p.log.success("Registered. New Claude Code sessions get cairn's search, open, brief, refs and related tools.");
        return "done";
      },
    },
    {
      id: "backfill",
      title: "Backfill",
      async check() {
        const client = await connect(socketPath(), 1000);
        if (!client) return { done: false, detail: "waiting for cairnd" };
        const api = new RemoteApi(client);
        try {
          const s = await api.status();
          const backlog = s.stats.exchanges - s.stats.embedded - s.stats.failed;
          const ran = Boolean(s.daemon?.lastIndex);
          const failed = s.stats.failed ? ` · ${s.stats.failed} set aside` : "";
          return {
            done: ran && backlog === 0 && !s.daemon?.indexing,
            detail: ran ? `${s.stats.embedded.toLocaleString()} exchanges indexed${backlog ? ` · ${backlog.toLocaleString()} to go` : ""}${failed}` : "not started",
          };
        } finally {
          api.close();
        }
      },
      run: () => watchBackfill(),
    },
  ];
}

/** `claude mcp add` for this CLI, with Node by a path that survives upgrades. */
function mcpAddArgs(): string[] {
  const cli = realpathSync(process.argv[1]!);
  if (!cli.endsWith(".js")) return [];
  return ["mcp", "add", "--scope", "user", "cairn", "--", nodePath(), cli, "mcp"];
}

/**
 * Shows cairnd's backfill until it's done, or until Enter. Closing this changes nothing: cairnd
 * keeps indexing, and after a crash or reboot it resumes from its cursors.
 */
async function watchBackfill(): Promise<"done"> {
  const client = await connect(socketPath(), 2000);
  if (!client) throw new StepError("cairnd isn't answering; run cairn init again.");
  const api = new RemoteApi(client);
  p.log.message("Press Enter to leave it running in the background.");
  const s = p.spinner();
  s.start("Indexing your sessions");
  let leave!: () => void;
  const left = new Promise<void>((resolve) => (leave = resolve));
  const stdin = process.stdin;
  // Enter or Ctrl-C: either way the backfill carries on in cairnd.
  const onKey = (k: Buffer) => {
    if (["\r", "\n", "\u0003"].includes(k.toString())) leave();
  };
  let leaving = false;
  void left.then(() => (leaving = true));
  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onKey);
  }
  try {
    await api.subscribe((e: CairnEvent) => {
      if (e.type === "embedding") s.message(`Embedding ${e.done.toLocaleString()} / ${e.total.toLocaleString()} exchanges`);
      if (e.type === "reparsed") s.message(`Re-deriving files and commits (${e.exchanges})`);
    });
    await api.trigger();
    const done = (async () => {
      while (!leaving) {
        await new Promise((r) => setTimeout(r, 2000));
        if (leaving) return undefined;
        const st = await api.status();
        const backlog = st.stats.exchanges - st.stats.embedded - st.stats.failed;
        if (st.daemon?.lastIndex && !st.daemon.indexing && backlog === 0) return st;
        if (st.daemon?.lastIndex?.result.embedError) s.message(`Waiting for Ollama: ${st.daemon.lastIndex.result.embedError}`);
      }
    })();
    const result = await Promise.race([done, left.then(() => undefined)]);
    if (result) s.stop(`Indexed ${result.stats.embedded.toLocaleString()} exchanges${result.stats.failed ? ` (${result.stats.failed} set aside: cairn index --retry-failed)` : ""}`);
    else s.stop("cairnd keeps indexing in the background (cairn live to watch; it resumes after restarts)");
  } finally {
    if (stdin.isTTY) {
      stdin.off("data", onKey);
      stdin.setRawMode(false);
      stdin.pause();
    }
    api.close();
  }
  return "done";
}

/**
 * Asks for an Anthropic key (hidden), checks it with Anthropic, then stores it. Empty input skips.
 * Shared by init's key step and `cairn key set`.
 */
async function promptForKey(): Promise<"done" | "skipped"> {
  const store = keyStore();
  p.log.info(`cairn ask sends the matching passages, secrets masked, to Claude Haiku. The key is checked, then stored in the ${store.where}; it's never written to a log or sent to cairnd.`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const key = answer(await p.password({ message: "Paste your Anthropic API key (hidden; leave empty to skip)", mask: "•" }))?.trim() ?? "";
    if (!key) return "skipped";
    if (!looksLikeKey(key)) {
      p.log.warn("That doesn't look like an Anthropic API key (they start with sk-ant-).");
      continue;
    }
    const s = p.spinner();
    s.start("Checking the key");
    try {
      // A free call that also confirms access to the model ask uses.
      await new Anthropic({ apiKey: key }).models.retrieve(ASK_MODEL);
      s.stop("Key works");
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) {
        s.error("Anthropic rejected that key");
        continue;
      }
      if (e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError) {
        s.error(`That key can't use ${ASK_MODEL}`);
        continue;
      }
      s.error("Couldn't reach Anthropic to check it");
      if (!answer(await p.confirm({ message: "Save it anyway?" }))) continue;
    }
    store.set(key);
    p.log.success(`Saved in the ${store.where}.`);
    return "done";
  }
  throw new StepError("No working key after three tries. Run cairn key set to try again.");
}

/** `cairn key set`: stores or replaces the key. False if it was cancelled or failed. */
export async function runKeySet(): Promise<boolean> {
  p.intro("cairn key set");
  const store = keyStore();
  if (store.get()) p.log.info(`This replaces the key stored in the ${store.where}.`);
  if (process.env.ANTHROPIC_API_KEY) p.log.warn("ANTHROPIC_API_KEY is set in your environment; cairn ask uses it instead of the stored key.");
  try {
    const result = await promptForKey();
    p.outro(result === "done" ? "cairn ask will use this key." : "Nothing changed.");
    return true;
  } catch (e) {
    if (e instanceof Paused) {
      p.cancel("Nothing changed.");
      return false;
    }
    p.log.error(e instanceof Error ? e.message : String(e));
    p.outro("Nothing changed.");
    return false;
  }
}

// ---- running it --------------------------------------------------------------------------

export async function runInit(options: { check?: boolean } = {}): Promise<boolean> {
  const state = loadState();
  const all = steps({ skipped: (id) => state.steps[id]?.status === "skipped" });
  // Before any step writes under it (the reranker download would create it world-readable).
  if (!options.check) {
    mkdirSync(cairnHome(), { recursive: true, mode: 0o700 });
    chmodSync(cairnHome(), 0o700);
  }
  p.intro(options.check ? "cairn init --check" : "cairn init");
  const unfinished = Object.entries(state.steps).find(([, s]) => s.status === "failed" || s.status === "paused");
  if (!options.check && unfinished) p.log.info(`Picking up where the last run stopped (at "${unfinished[0]}").`);

  let current: string | undefined;
  // Ctrl-C outside a prompt (mid-download, say). A spinner's own handler runs first and
  // redraws its line, hence setImmediate.
  const onSigint = () =>
    setImmediate(() => {
      if (current && !options.check) {
        state.steps[current] = { status: "paused", at: new Date().toISOString() };
        saveState(state);
      }
      p.cancel("Setup paused. Run cairn init to continue; finished steps are kept.");
      process.exit(130);
    });
  process.on("SIGINT", onSigint);
  try {
    return await runSteps(all, state, options, (id) => (current = id));
  } finally {
    process.off("SIGINT", onSigint);
  }
}

async function runSteps(all: Step[], state: InitState, options: { check?: boolean }, onStep: (id: string) => void): Promise<boolean> {
  let ok = true;
  for (const step of all) {
    onStep(step.id);
    const c = await step.check();
    if (c.done) {
      p.log.success(`${step.title}: ${c.detail}`);
      state.steps[step.id] = { status: c.skipped ? "skipped" : "done", at: new Date().toISOString(), detail: c.detail };
      continue;
    }
    if (options.check) {
      p.log.warn(`${step.title}: ${c.detail}`);
      ok = false;
      continue;
    }
    p.log.step(`${step.title}: ${c.detail}`);
    try {
      const status = await step.run();
      state.steps[step.id] = { status, at: new Date().toISOString() };
      saveState(state);
    } catch (e) {
      if (e instanceof Paused) {
        state.steps[step.id] = { status: "paused", at: new Date().toISOString() };
        saveState(state);
        p.cancel("Setup paused. Run cairn init to continue; finished steps are kept.");
        return false;
      }
      const message = e instanceof Error ? e.message : String(e);
      state.steps[step.id] = { status: "failed", at: new Date().toISOString(), detail: message };
      saveState(state);
      p.log.error(message);
      p.outro("Stopped. Fix that and run cairn init again; finished steps are kept.");
      return false;
    }
  }
  if (!options.check) saveState(state);
  p.outro(options.check ? (ok ? "Everything is set up." : "Run cairn init to finish setting up.") : 'cairn is set up. Try: cairn search "…" · cairn live');
  return ok;
}
