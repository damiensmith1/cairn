---
title: Packaging
tags: [cairn, packaging, distribution]
status: draft
---

# Packaging

How cairn is installed, runs and is used. The core design is in
[[design]]; this page is the product shape around it. Decided 2026-10-16
unless marked open.

## Shape

A CLI you install. On first run it sets up the local models, detects
which coding agents you use, and starts a background service that
watches their session logs, stores and indexes everything. You search
from the CLI (commands or a dashboard), and any agent can ask cairn
through MCP.

```
                    ┌──────────── cairnd (background service) ────────────┐
 sources (plug-ins) │ watcher → store (SQLite) → embed → label → pointers │
  claude-code ─────►│                                                     │
  codex ───────────►│ query server: understand → retrieve → rank → shape  │
  more later ──────►│ keeps models warm: Ollama (Qwen3), Laya sidecar     │
                    └──────────────────────▲──────────────────────────────┘
                                           │ local socket
                    ┌──────────────────────┼─────────────────────┐
              cairn CLI / TUI          cairn MCP            Clance (later)
          setup · dashboard · search   any agent: Claude Code, Codex, Cursor…
```

## Processes

**cairnd** is the one long-running process. It owns:
- **the watcher** for every enabled source,
- **the store**: it is the only writer to the SQLite file,
- **the models**, kept warm so queries are fast: Qwen3 embeddings through
  Ollama (which unloads it when idle), the MiniLM reranker (unloaded after
  ~10 idle minutes), and Laya later,
- **the query server**: understand, retrieve, rank, shape.

**The watcher** (decided 2026-10-18): `fs.watch` on each source's folder
(FSEvents on macOS) triggers a catch-up after a short debounce, plus a
sweep every 60 s that catches missed events and completes exchanges idle
for 10 minutes (which no file change announces). Work runs through one
queue: ingest → pointers → embed → labels, one job at a time; a trigger
during a job schedules exactly one more run.

Started at login by launchd (a LaunchAgent that setup installs), at
normal priority (`ProcessType: Standard`), restarted if it crashes.
Background priority was tried and reversed: macOS throttled searches
from ~0.5 s to 6–44 s ([[experiments]]). Keeping a backfill from taking
over the machine is a matter of limiting Ollama, which does the heavy
work (open question below). `cairn service
start|stop|status` manages it; `cairn daemon` runs it in the foreground.
Logs go to `~/.cairn/logs/cairnd.log`.

**Thin clients** talk to cairnd over a local socket and hold no models:
- `cairn` (CLI and dashboard),
- `cairn mcp` (an MCP server over stdio that forwards to cairnd),
- Clance later, importing the client library.

Why a daemon: Laya takes seconds to load, so a CLI that loaded its own
models would start slowly on every search. One process also means one
writer to SQLite and one place that holds memory.

## Sources: harness plug-ins

Each coding agent is a **source** plug-in that answers three questions:

```ts
interface Source {
  id: string                                   // "claude-code", "codex", …
  detect(): Promise<boolean>                   // installed on this machine?
  locations(): Promise<string[]>               // where its session logs live
  read(location, cursor): AsyncIterable<Event> // what's new since the cursor
  toExchanges(events): Exchange[]              // normalise into cairn's model
}
```

The rest of cairn only sees normalised exchanges, tagged with the source
they came from.

**Finding the logs.** Each source has default locations and detection;
config overrides them, and a source can have several paths (a second
config folder, a folder synced from another machine):

```toml
[sources.claude-code]
paths = ["~/.claude/projects", "~/work-claude/projects"]
```

- Done: Claude Code's default follows its own `CLAUDE_CONFIG_DIR`
  (`<config dir>/projects`); `CLAUDE_PROJECTS_DIR` overrides it directly.
- Planned: `paths` in `config.toml`; `cairn init` and the dashboard's
  Sources screen show what was detected ("Claude Code: 404 sessions in
  ~/.claude/projects") and let you add or change paths. Claude Code first. Codex keeps local session logs too,
so it should be a small plug-in once its format is checked. Others
(Gemini CLI, Cursor, Aider) follow the same interface.

**Clients are pluggable for free:** MCP is supported by Claude Code,
Codex, Cursor and others, so any of them can *ask* cairn regardless of
which sources it reads.

## Runtime

- **TypeScript on Node 22+** for cairnd, the CLI, the dashboard and the
  MCP server: the author's stack, and the official MCP SDK.
- **SQLite** (FTS5 + sqlite-vec) from Node.
- **Ollama** over HTTP for Qwen3-Embedding.
- **Label probes** are a small file of weights per label, evaluated in
  TypeScript; trained offline (scikit-learn in the spikes).
- **Node everywhere by default (decided 2026-10-18):** a user installs
  Node and Ollama, nothing else.
- **Reranker:** MiniLM-L6 via ONNX Runtime in Node, in a worker thread;
  see the reranker question in [[design]].
- **Laya:** the official `laya-ts` (ONNX in Node, vendored; model exported
  once by us and downloaded at setup), if it passes its measurement (CPU
  ≲ 0.5 s per question, same answers as Python). Fallback: a Python
  sidecar (`laya-serve` in a `uv` environment under `~/.cairn/`), optional
  at setup and used only for free-text intent in the CLI.
- **Python GPU reranker:** not in the default install; at most a later
  opt-in quality mode.

## Memory on an 8 GB machine

Qwen3 uses ~1.5 GB while embedding; Laya ~0.6–1.8 GB when loaded.
- Ollama unloads the embedding model after a few idle minutes.
- cairnd loads Laya lazily on the first free-text query and unloads it
  after a period without queries.
- MCP queries usually don't need Laya at all: the agent passes intent.

## First run

`cairn init` (or the first `cairn` launch) walks through:

1. **Check the machine:** RAM, free disk, Node version.
2. **Ollama:** detect it; offer to install it if missing; pull
   `qwen3-embedding:0.6b` (~640 MB).
3. **Query understanding (optional):** "Install Laya for free-text
   questions?" (size depends on the runtime: ONNX in Node if `laya-ts`
   passes, else a ~2.2 GB Python sidecar) Explains the trade-off: without it, free-text
   questions in the CLI fall back to rules and plain similarity.
4. **Sources:** detect installed agents (Claude Code, Codex, …) and let
   you pick which to watch.
5. **Projects:** propose a project list from what it finds, with
   aliases, used for project detection.
6. **Service:** install and start cairnd.
7. **Backfill:** index existing history in the background with progress
   (~50 min for the author's history), resumable.
8. **MCP:** offer to register `cairn mcp` with the detected agents.

## CLI

```
cairn                         dashboard
cairn init                    first-run setup (re-runnable)
cairn search <query>          hybrid search, top 10 reranked with MiniLM (--no-rerank to skip)
cairn decisions <query>       intent: decision (labels boost decisions)
cairn unresolved <query>      intent: open questions ("open" is the passage-opening operation)
cairn refs <file|sha|pr|url>  pointer lookup
cairn related <session>       sessions sharing files, commits and links
cairn sessions <query>        find a session
cairn open <#id>              an exchange from the results, with its neighbours (--around N, --full)
cairn brief <session|#id>     extractive session brief (id, unique prefix, or an exchange id)
cairn ask <question>          free text; answers with citations (Claude Haiku 5.5)
cairn sources                 list / enable / disable sources
cairn status                  index, backlog, model health
cairn live                    cairnd's status and activity, as it happens
cairn rebuild [index]         rebuild indexes or labels from the store
cairn service start|stop|status
cairn mcp                     MCP server over stdio (for agents)
```

Explicit commands carry their intent, so only `search` and `ask` need
query understanding.

## Live view (built 2026-10-18)

`cairn live` subscribes to cairnd's event stream over the socket (a
`subscribe` call, then JSON-RPC notifications) and shows a status header
(pid, uptime, idle / indexing / embedding progress, Ollama, reranker;
exchanges, embedded, backlog, pointers, labels; last sweep and index)
above a feed: logs that changed, exchanges read, embedded and labelled,
searches with their latency, the reranker loading and unloading, errors.
Quiet sweeps update the header instead of the feed, and a session being
written (a change every few seconds while its exchange is still in
progress) folds into one line that counts updates, `writing Clance Chat ·
exchange in progress (12 updates)`, until the exchange completes. cairnd keeps the last
200 events, so a late joiner sees recent history. It reconnects when
cairnd restarts; piped, it streams plain lines. Plain ANSI, no new
dependency; it can become a panel of the dashboard.

## Dashboard (v1 scope)

A terminal UI built with Ink (React for terminals):
- **Sources:** toggle which agents are watched; last activity per source.
- **Status:** exchanges indexed, backlog, embedding and label progress,
  model health (Ollama up, Laya loaded or not), disk used.
- **Search:** type a query, browse results grouped by session, open a
  passage or a brief.

## Data and config

```
~/.cairn/
  config.toml      sources, projects and aliases, model choices
  cairn.db         the store and indexes (SQLite)
  models/          label probe weights
  laya/            uv environment for the Laya sidecar (if installed)
  logs/            cairnd logs
  spikes/          experiment data (not part of the product)
```

## Distribution

- **npm:** `@damiensmith1/cairn`, with the `cairn` command, the client
  library, and `/mcp`.
- **Homebrew:** a formula in the author's tap (as for Clance) that
  depends on Node, Ollama and `uv`.

## Open questions
- [x] **Socket protocol:** JSON-RPC 2.0 over a Unix socket at
      `~/.cairn/cairnd.sock` (owner-only), newline-delimited. No port, and
      access is controlled by file permissions; a localhost HTTP port can
      be reached by any local process or web page. Decided 2026-10-18.
- [x] **CLI without cairnd:** when the socket isn't there, the CLI does
      the work in process, as before. Decided 2026-10-18.
- [ ] **Throttling a backfill:** limit Ollama's threads per request
      (`num_thread`) or pace embedding batches, so the first backfill
      leaves the machine usable. Measure the backfill-speed cost.
- [ ] **Re-reading the open exchange:** the watcher re-reads the exchange
      still in progress from its start on every change; cache its parse
      for very long turns.
- [ ] **Codex log format:** location, schema, and how sessions and turns
      map to exchanges.
- [ ] **Laya in Node via ONNX** instead of a Python sidecar: would remove
      Python from the install. Checked 2026-10-18: the official repo has
      **`laya-ts`**, TypeScript inference on Node (and the browser) through
      ONNX Runtime, porting `Agent.predict`, `Router` and the question
      types. Catches: (1) it's not on npm (version 0.1.0, in the repo
      only), so cairn would vendor it (Apache 2.0); (2) it needs the model
      split into `encoder.onnx` + `head.onnx`, which the official Hugging
      Face repo doesn't host: they come from a one-time Python export
      (`laya-ts/scripts/export_onnx.py`). That's a build-time step for
      cairn's developer, not the user; the exported files could be hosted
      for download (Apache 2.0). A third-party `tozp/laya-onnx` has
      single-file exports (including int8) in a different layout,
      unofficial; (3) speed and memory on the CPU are unmeasured
      (ModernBERT-large, ~400M parameters; one pass per question, not per
      candidate).
- [ ] **Linux support:** a systemd user unit instead of launchd.
- [x] **What `ask()` uses for answers:** the Anthropic API with the
      user's key (`ANTHROPIC_API_KEY`), model **Claude Haiku 5.5**: cheap
      and fast, enough to answer from retrieved passages. Decided by the
      author, 2026-10-18.
- [ ] **Upgrades:** re-embedding when the embedding model changes (the
      store is the source of truth; `rebuild` covers it).
