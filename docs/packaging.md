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
  Ollama, and Laya through a Python sidecar it starts and stops,
- **the query server**: understand, retrieve, rank, shape.

Started at login by launchd (a LaunchAgent that setup installs); `cairn
service start|stop|status` manages it.

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
- **Laya** runs as a Python sidecar (`laya-serve`, Jev-compatible HTTP)
  in its own `uv` environment under `~/.cairn/`, started by cairnd when
  needed. (ONNX inside Node is a possible alternative; unverified.)

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
   questions (~2.2 GB)?" Explains the trade-off: without it, free-text
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
cairn search <query>          hybrid search
cairn decisions <query>       intent: decision (labels boost decisions)
cairn unresolved <query>      intent: open questions ("open" is the passage-opening operation)
cairn refs <file|sha|pr|url>  pointer lookup
cairn related <session>       sessions sharing files, commits and links
cairn sessions <query>        find a session
cairn brief <session>         extractive session brief
cairn ask <question>          free text; answers with citations (LLM)
cairn sources                 list / enable / disable sources
cairn status                  index, backlog, model health
cairn rebuild [index]         rebuild indexes or labels from the store
cairn service start|stop|status
cairn mcp                     MCP server over stdio (for agents)
```

Explicit commands carry their intent, so only `search` and `ask` need
query understanding.

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
- [ ] **Socket protocol** between clients and cairnd: JSON-RPC over a
      Unix socket, or local HTTP.
- [ ] **Codex log format:** location, schema, and how sessions and turns
      map to exchanges.
- [ ] **Laya in Node via ONNX** instead of a Python sidecar: would remove
      Python from the install if it works and matches accuracy.
- [ ] **Linux support:** a systemd user unit instead of launchd.
- [ ] **What `ask()` uses for answers** in the CLI: which LLM API, and
      the user's key.
- [ ] **Upgrades:** re-embedding when the embedding model changes (the
      store is the source of truth; `rebuild` covers it).
