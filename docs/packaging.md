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
  more later ──────►│ keeps models warm: Ollama (Qwen3), MiniLM reranker  │
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
  ~10 idle minutes),
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

Why a daemon: models take time to load, so a CLI that loaded its own
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
- Done (2026-10-18): `paths` in `~/.cairn/config.toml`, written by
  `cairn init`, which shows what it detected ("Watch Claude Code sessions
  in ~/.claude/projects (404 found)?") and takes extra folders. Without a
  config file, the default above applies.
- Planned: the dashboard's Sources screen to change them. Claude Code first. Codex keeps local session logs too,
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
- **Laya:** shelved (2026-10-18) for performance and RAM/disk cost; see
  [[design]] Decisions. Free-text intent in the CLI uses rules for now.
- **Python GPU reranker:** not in the default install; at most a later
  opt-in quality mode.

## Memory on an 8 GB machine

Measured 2026-10-18: cairnd idles at ~60 MB; Ollama holds the
embedding model (~0.9–1 GB) while embedding and unloads it after a few
idle minutes; the reranker loads into cairnd for searches and unloads
after ~10 idle minutes. Laya would have added ~0.6 GB while loaded (int8)
or ~1.8 GB (fp32), one reason it's shelved.

Disk for a working install, measured on the author's Mac: ~1.4 GB
(embedding model 639 MB, `node_modules` 597 MB, store 91 MB for 3,881
exchanges, reranker 110 MB). `node_modules` can shrink when packaged:
`onnxruntime-node` ships every platform's binaries (287 MB) and
`onnxruntime-web` (140 MB) comes in through transformers.js unused.

## First run

`cairn init` walks through these steps (built 2026-10-18 unless marked
later):

1. **Machine:** Node ≥ 22 and ≥ 2 GB free disk (stops otherwise); warns
   under 8 GB RAM.
2. **Ollama:** detect it (the app, a Homebrew formula or another CLI
   install). If it's missing, ask, then run `brew install ollama` (or point
   to ollama.com without Homebrew). Start it the way it's installed, then
   pull `qwen3-embedding:0.6b` (~640 MB) with progress. Ollama keeps
   partial layers, so an interrupted pull resumes; init retries it 5 times.
3. **Reranker:** fetch MiniLM-L6 (~23 MB) into `~/.cairn/models/`. A
   broken cache (download cut short) is deleted and fetched once more.
4. **Sources:** detect Claude Code's projects folder, count its sessions,
   confirm, take extra folders, write `~/.cairn/config.toml` (0600).
5. **API key** for `cairn ask` (optional): a hidden prompt; empty skips
   (remembered, so later runs don't ask again). The key is checked for
   shape, then with Anthropic (a free `models.retrieve` of Claude Haiku
   5.5, which also confirms access), then stored in the **macOS
   Keychain**, written through `security -i` on stdin so it never appears
   in a process's arguments. It's never written to a file or log and never
   sent to cairnd; `ask` reads it in the caller's process.
   `ANTHROPIC_API_KEY` overrides it. Other platforms: `~/.cairn/credentials`
   (0600). Afterwards `cairn key set|remove|status` adds, replaces,
   removes or reports it (init skips a finished step, so it isn't the
   place to change the key). Note: the `security`
   tool is on the item's access list, so a process running as the user can
   read it that way, as with any CLI-stored Keychain item.
6. **Service:** install and start cairnd (launchd), and restart it when
   the sources changed after it started.
7. **Backfill:** cairnd indexes existing history; init shows its progress
   until done, or Enter leaves it running (~50 min for the author's
   history).
8. Later: a **project list** with aliases, and registering
   **`cairn mcp`** with the detected agents. (Laya was planned here as an
   optional step; shelved 2026-10-18.)

**Resumable.** Each step checks the real state first (is the model there,
is the key stored, did cairnd start after the config changed) and only
does what's missing, so after Ctrl-C, a crash or a reboot, `cairn init`
picks up where things stand. `~/.cairn/init.json` records each step's
outcome so a rerun can say where the last one stopped. `cairn init --check`
only reports. The backfill itself survives crashes on its own: cursors
and the unembedded queue live in the store (tested: `kill -9` at 96/200
exchanges, restart, the other 104 embedded, no duplicates).

**Fault-tolerant embedding.** A failed batch is retried with backoff
(1 s, 4 s, 15 s). If Ollama itself is down the run stops and the next one
resumes. Otherwise the batch is embedded one exchange at a time and any
that still fail are recorded; after 3 failed runs an exchange is set aside
so it can't block the rest (`cairn status` shows the count;
`cairn index --retry-failed` queues them again).

## CLI

```
cairn                         dashboard
cairn init                    first-run setup (resumable; --check only reports)
cairn key set|remove|status   the Anthropic key ask uses (macOS Keychain)
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
  model health (Ollama up, reranker loaded or not), disk used.
- **Search:** type a query, browse results grouped by session, open a
  passage or a brief.

## Data and config

```
~/.cairn/
  config.toml      sources, projects and aliases, model choices
  cairn.db         the store and indexes (SQLite)
  models/          label probe weights
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
- [x] **Laya in Node via ONNX** instead of a Python sidecar. **Shelved
      2026-10-18** before the export: perfect intent doesn't improve the
      retrieval eval yet, and int8 Laya costs ~450 MB disk, ~0.6 GB RAM
      and ~0.3 s per query; the export itself needs ~4–5 GB RAM once
      (fp32 model, ONNX build and verification in memory together). See
      [[design]] Decisions and [[experiments]]. What was found: would remove
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
      user's key, model **Claude Haiku 5.5**: cheap and fast, enough to
      answer from retrieved passages. Decided by the author, 2026-10-18.
      The key is stored by `cairn init` in the macOS Keychain
      (`ANTHROPIC_API_KEY` overrides it); see First run.
- [ ] **Upgrades:** re-embedding when the embedding model changes (the
      store is the source of truth; `rebuild` covers it).
