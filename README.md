# cairn

Searchable memory for your Claude Code sessions.

Claude Code saves every session as a log, but there's no way to search what
was said or decided inside them. cairn watches those logs, stores each
exchange (your message and the reply), and indexes it on your machine, so
you, or your agent over MCP, can ask "what did we decide about X?", read the
conversation around the answer, or get a brief of a whole session.

**Local:** cairn runs on your machine. The store, the embedding model
(through Ollama), the reranker (ONNX), labelling and search all run
locally, with no cloud service and no telemetry, so your conversations stay
on your computer. The one exception is optional: `cairn ask` sends the
passages it found to Anthropic's API to write an answer.

**Techniques:**

- **Hybrid retrieval:** BM25 keyword search (SQLite FTS5) and dense vector
  search (Qwen3-Embedding-0.6B through Ollama, vectors in sqlite-vec),
  merged with reciprocal rank fusion.
- **Cross-encoder reranking:** MiniLM-L6 (int8 ONNX, run in Node) re-scores
  the top 10 by reading the question and each passage together.
- **Contextual chunks:** each exchange is embedded with a short header
  (project, session, date, files, commits) and the end of the previous
  reply; long exchanges are split with overlap.
- **RAG:** `cairn ask` retrieves the best passages and has Claude Haiku
  answer from them alone, with citations. Through MCP, agents do agentic
  RAG: they decide when to search and answer from what comes back.
- **A pointer graph:** files, commits, PRs and URLs link exchanges across
  sessions.
- **A content-addressed, append-only store:** every exchange is stored once
  under a hash and never edited; the keyword index, vectors, labels and
  pointers are all derived from it.
- **Measured:** a retrieval eval (recall@k, MRR) with a held-out test half
  decides which of these stay.

## What it does

- **Search** your past sessions by keyword and by meaning. Results come back
  word for word, grouped by session.
- **Open** an exchange with its neighbours, **brief** a session (dates,
  commits, files edited, key exchanges), find every exchange that touched a
  file, commit, PR or URL (**refs**), and sessions that share them
  (**related**).
- **Ask** a question and get an answer written from your sessions (RAG):
  cairn retrieves the best-matching passages and Claude Haiku answers only
  from them, citing each one it uses as `[#id]`, and says so when they don't
  answer the question. Uses your own Anthropic key.
- **MCP server** for agents: search, open, brief, refs and related as
  read-only tools, so the agent retrieves for itself (agentic RAG). A session's own exchanges that its agent still has in
  context are left out of its searches.
- **cairnd**, a background service (launchd), picks up new exchanges as you
  work. The store is append-only, and setup, backfill and embedding all
  resume after a crash or reboot.
- **History** of every search and which results were opened.

## How it works

```
~/.claude/projects/**/*.jsonl
        │  watched by cairnd
        ▼
  SQLite store ── exchanges (append-only) · keywords (FTS5) · vectors (sqlite-vec)
        │         · pointers (files, commits, PRs, URLs)
        ▼
  query: keyword + vector → fuse → rerank the top 10 → group by session
        ▲                                   ▲
   cairn CLI ──── local socket ────── cairn mcp (Claude Code, any MCP client)
```

The CLI and the MCP server are thin clients of cairnd over a Unix socket; if
cairnd isn't running, the CLI does the work in its own process.

## Quick start

Needs macOS and Node 22+; `init` installs Ollama if it's missing.

```bash
npm install -g @damiensmith1/cairn
cairn init
```

`init` walks through setup and can be re-run at any point: it checks the
machine, removes the parts of cairn's dependencies it never uses (other
platforms' binaries, a browser runtime: ~560 MB down to ~120 MB), installs
and starts Ollama (after asking), pulls the embedding model (~640 MB),
fetches the reranker (~23 MB), asks which session folders to watch,
optionally stores an Anthropic key for `ask` in the macOS Keychain, installs
cairnd, offers to register the MCP server with Claude Code, and indexes your
existing sessions. `cairn init --check` only reports.

From source: `git clone https://github.com/damiensmith1/cairn`, then
`npm install && npm run build` and `node dist/cli.js init`.

## Commands

```
cairn search <query>          hybrid search, top 10 reranked
cairn open <#id>              an exchange with its neighbours
cairn brief <session|#id>     what a session was: dates, commits, files, key exchanges
cairn ask <question>          an answer from your sessions, with citations
cairn refs <file|sha|#pr|url> every exchange that edited or mentioned it
cairn related <session>       sessions sharing the most files, commits and links
cairn history [<n>]           past searches, or what search n returned
cairn status                  what's stored and indexed
cairn live                    cairnd's activity as it happens
cairn init [--check]          set up, or check the setup
cairn key set|remove|status   the Anthropic key used by ask
cairn mcp                     the MCP server, over stdio
cairn service start|stop|status
```

## What stays on your machine

- Everything cairn stores and computes: the store, embeddings, reranking,
  labels and search history, under `~/.cairn/` (owner-only). No cloud
  service, no telemetry. Setup downloads the models; nothing is uploaded.
- The one exception: `cairn ask` sends the matching passages to Anthropic's
  API with your key, credentials masked first. Without a key (stored by
  `cairn key set` or in `ANTHROPIC_API_KEY`), `ask` can't send anything.
- Results you give an agent through MCP become part of that agent's
  conversation, like anything else you show it. cairn masks credentials in
  them and marks them as data rather than instructions.

## Numbers

Measured on an M2 MacBook Air with 8 GB of RAM, over ~3,900 exchanges from
~400 sessions:

- Search, including reranking: 0.35–0.6 s when warm. The first search after
  a few idle minutes takes several seconds while models load.
- On a retrieval eval of 146 questions (written by an LLM from known answers
  and checked blind by another), the reranker lifts test MRR from 0.71 to
  0.79, and the right session is in the top 5 for ~99% of questions.
- Disk: ~120 MB for cairn once `init` has trimmed it, ~640 MB for the
  embedding model in Ollama, and the store (~90 MB for ~3,900 exchanges).
  RAM: ~60 MB for cairnd when idle, about 1 GB more while Ollama embeds.

## Docs

The design, the decisions behind it and the experiments that settled them,
with data, are in [`docs/`](docs/): [background](docs/background.md),
[requirements](docs/requirements.md), [design](docs/design.md),
[packaging](docs/packaging.md) and [experiments](docs/experiments.md).
