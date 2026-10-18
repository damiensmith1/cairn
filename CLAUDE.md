# cairn

Searchable memory for agent sessions. A watcher follows Claude Code
transcripts (`~/.claude/projects/*/*.jsonl`), appends each exchange to an
append-only store keyed by content hash, and indexes it by keywords,
embeddings and local labels. `search`, `open`, `brief` and `ask` resurface
the verbatim conversation with its source. A background service (cairnd)
runs the core; the CLI, a terminal dashboard and an MCP server are thin
clients. Sources are plug-ins per coding agent (Claude Code first).

Status: build steps 1–2 work on real data: ingest, local embeddings,
hybrid search, a MiniLM reranker (on by default), pointers
(`refs`, `related`) and label probes with boosting (boost not yet tuned). No daemon, query understanding or MCP
yet. See the build order in
docs/design.md.

## Commands
- `npm test`: unit tests on synthetic transcripts (never real sessions)
- `npm run typecheck`
- `npm run cairn -- index [--no-embed] [--limit N]`: read new logs, embed what's new
- `npm run cairn -- search|decisions|unresolved "<query>" [--project P] [--since DATE] [--topic T] [--no-rerank]` (reranking is on by default)
- `npm run cairn -- refs <file|sha|#pr|url>` and `npm run cairn -- related <session>`
- `npm run eval:retrieval -- sample|run|reranked`: the retrieval eval (data in
  `~/.cairn/evals/retrieval/`); re-run it after any change to chunking,
  ranking, labels or embeddings, and record results in docs/experiments.md
- `npm run train-labels`: trains the label probes into `~/.cairn/models/labels.json`
  from labelled exchanges (the spike's data in `~/.cairn/spikes/decisions/`)
- `npm run cairn -- status`
- Data lives in `~/.cairn/` (or `CAIRN_HOME`); tests use a temp dir and an
  in-memory store.

## Docs

Read these before non-trivial changes:
- `docs/background.md`: the problem, the data, principles
- `docs/requirements.md`: v1 scope, later, non-goals, success metrics
- `docs/design.md`: architecture, data model, pipeline, decisions, open questions
- `docs/experiments.md`: spikes that settled design questions, with data
- `docs/packaging.md`: how it's installed and runs: cairnd, sources, CLI, dashboard, MCP, setup

## Conventions
- Never modify transcripts. They are read-only input.
- The store is append-only: records are never edited or deleted. Indexes
  and enrichments are derived and must be rebuildable from the store.
- Everything is keyed by content hash; ingest must be idempotent.
- An LLM writes text only to answer a question (`ask`), from retrieved
  passages, with citations. No background summarising.
- Only conversation text goes to external services, never tool output.
- `~/.cairn/` holds whole conversations: keep it owner-only (folder 0700,
  files 0600).
- Version enricher outputs (e.g. label question wording, model version) as part of their key.

## Keeping docs in sync

Everything under docs/ is this project's source of truth, not a one-time
snapshot — including any file added there after initial setup, not just
background.md/requirements.md/design.md. In the SAME turn as a code
change (not a followup), update the relevant doc when you:
- resolve or add an open question in design.md
- make or change an architecture/approach decision
- add, change, or drop a requirement or non-goal
- learn something that changes the "why" in background.md
- create a new doc under docs/ for a topic that doesn't fit the above

Don't fabricate a decision that wasn't actually made. If it's unclear
whether something is doc-worthy, ask instead of guessing.
