---
title: Design
tags: [cairn, design]
status: draft
---

# Design

Implements [[requirements]]. Context in [[background]]. Measurements and
spikes behind these choices are in [[experiments]].

## Architecture

```
 ~/.claude/projects/*/*.jsonl  (append-only logs, never modified)
        │  watcher: tail each file from its saved offset
        ▼
 ┌─ core library ──────────────────────────────────────────────────────┐
 │ sources/    parse transcripts into exchanges (claude-code first)     │
 │ store/      append-only records, keyed by content hash               │
 │ indexes/    keyword (FTS5) · vector (Qwen3-Embedding, local)         │
 │ enrichers/  labels: decision · unresolved · topic   (local models)   │
 │             pointers: files · commits · URLs · PRs  (deterministic)  │
 │ query/      understand → retrieve → rank → shape → answer            │
 │             search · refs · open · brief · ask                       │
 └─────────────────────────────────────────────────────────────────────┘
```

The core runs inside **cairnd**, a background service that owns the
watcher, the store and the warm models; the CLI, the dashboard, the MCP
server and later Clance are thin clients over a local socket. Sources
are plug-ins, one per coding agent. See [[packaging]].

The core knows nothing about MCP or the terminal. Same shape as
[[Projects/lode/docs/background|lode]]: core plus thin adapters.
Everything that indexes runs on the machine; the only text that ever
leaves it is the passages `ask()` sends to an LLM to write an answer.

## Data model

**Exchange** (the unit of storage and retrieval): one user message plus
the assistant's reply up to the next user message.

```
Exchange {
  hash          sha256 of source, session, the user entry's id, and the user and
                assistant text (the id keeps two identical "yes" replies apart)
  source        "claude-code"
  project       decoded from the transcript folder (see Findings: often uninformative)
  session       session id (+ name when the log has one)
  at            timestamp of the user message
  user          the user's text
  assistant     the assistant's text (tool output excluded)
  files         paths edited (Edit/Write tool calls)
  commits       messages of git commits made in this exchange
  offset        position in the transcript, for open()
}
```

**Derived records**, appended next to exchanges and never edited:

```
Enrichment { exchange_hash, enricher, version, output, at }
  e.g. labels v1 → { p_decision, p_unresolved, topic: {choice, probabilities} }
```

**Pointers** are an enrichment too, one record per reference:

```
Pointer { exchange_hash, kind, target, relation }
  kind      file | commit | url | pr | session
  target    normalised: repo-relative path, full SHA, canonical URL
  relation  mentions | edited | committed
```

Together they form a graph: exchanges are linked through shared targets.

Enrichments are keyed by `exchange_hash + enricher + version`: each
exchange is enriched once per version, and a new version re-enriches
exactly what's affected. This also absorbs label models' run-to-run noise
(Jev's was measured in [[llm-cassette]]): a label is computed once and
stored, never recomputed by accident.

## Ingest pipeline

1. **Watch** each transcript; remember a byte offset per file. On start,
   catch up from saved offsets. Read only complete lines (a session may be
   mid-write).
2. **Parse** new lines into exchanges. An exchange is complete when the
   next user message arrives or the session goes idle (no writes for 10
   minutes). The exchange still in progress is re-read next time, from
   the cursor saved at its user message. Typed user messages come as text
   or as text-plus-image lists; tool results, slash-command echoes, task
   notifications, meta and compaction entries are not user messages.
   Subagent transcripts (nested folders) are skipped in v1; entries are
   read in file order (conversation branches from edits and rewinds are
   not followed yet).
3. **Append** to the store if the hash is new. Same content, same hash, so
   it's skipped: ingest is idempotent.
4. **Index:** keyword index and embedding. The embedded text is a
   **contextual chunk**: a short header from the exchange's own metadata,
   plus the tail (~150 tokens) of the previous reply, then the exchange:
   ```
   project: llm-cassette · session: <name> · 2026-10-16
   files: src/match/jev.ts · commit: Release 0.2.0
   ---
   [previous reply, end] …  [user] …  [assistant] …
   ```
   Deterministic, built from fields already parsed; no LLM. Exchanges
   longer than a target chunk size are split with ~10–15% overlap; each
   piece keeps the header and links back to its exchange.
5. **Enrich:** run each enricher whose output for this hash and version is
   missing: labels (from the embedding already computed) and pointers.

Steps 4–5 read only from the store, so `rebuild` replays them over the
whole store, the way a read model is rebuilt from an event log
([[CQRS (Command Query Responsibility Segregation)]]).

## Query layer

Every question goes through five steps:

```
 "what did we decide about the cassette threshold?"
        │
 1. UNDERSTAND   intent = decision · project = llm-cassette · refs = none
        │
 2. RETRIEVE     keyword search ∪ vector search, filtered to the project
        │        (refs intent: pointer-graph lookup instead)
        ▼
 3. RANK         merge both lists → boost by labels → optional rerank
        ▼
 4. SHAPE        group by session, attach source (project · session · date)
        ▼
 5. ANSWER       Claude Code: the agent reads the passages and answers
                 CLI / Clance: ask() sends the passages to an LLM; answer with citations
```

**1. Understand.** Intent is one of `decision`, `open`, `recall`,
`find_session`, `refs`; project is one of the known projects or none.
- In Claude Code the agent already understands the question and passes
  intent and filters itself; cairn skips this step.
- In the CLI and Clance, cairn does it: rules for structural intents
  (file paths, SHAs, PR numbers → `refs`) and exact project aliases;
  **Laya** for paraphrased intents ("what'd we land on", "anything left
  hanging"), where it scored 0.75 against rules' 0.38; embedding
  similarity to project descriptions for misheard names ("prompt tuna"),
  with a cut-off so it can answer "none". Candidate design from
  [[experiments]]; to be confirmed on fresh queries.

**2. Retrieve.** Keyword hits (FTS5) and vector hits (nearest neighbours)
in parallel, filtered by project and date when known. For `refs`, the
pointer graph answers exactly instead.

**3. Rank.** Merge the two lists (reciprocal rank fusion, proposed), then
boost by the label that matches the intent. Optional steps, each kept
only if the retrieval eval shows a gain: a **reranker** that reads query
and passage together and reorders the top ~50, and **link expansion**
that adds exchanges sharing pointers with the top hits (a light
GraphRAG).

**4. Shape.** Group by session; every passage carries project, session,
time and offset, so it can be opened in place.

**5. Answer.** Generation happens only here, only from the retrieved
passages, with citations.

**What the intent changes:**

| Intent | Retrieval | Ranking and output |
|---|---|---|
| decision | hybrid search | boost high p_decision, newest first |
| open | hybrid search | keep high p_unresolved, drop anything settled later |
| recall | hybrid search | best match, plus `open()` for surrounding context |
| find_session | hybrid search | one result per session, with its `brief` |
| refs | pointer graph (file / commit / PR) | every mention, in time order |

**Operations:**
- **search(query, filters)**: steps 1–4; returns verbatim passages.
- **refs(target)**: every exchange pointing at a file, commit, URL or PR,
  across sessions, in time order. Exact, not fuzzy.
- **open(source)**: the exchanges around a passage, verbatim.
- **brief(session)**: session name, project, dates, commits, files
  touched, top exchanges by p_decision, and related sessions (those
  sharing the most pointers). Extractive, nothing generated.
- **ask(question)**: steps 1–5; the only place cairn generates text.

## Storage

Behind a small interface so the backend can change:

```ts
interface Store {
  append(record): boolean        // false if the hash already exists
  get(hash): Record | undefined
  scanSince(cursor): Iterable<Record>
}
```

One local SQLite file holding the append-only tables, keyword search
(FTS5) and vectors (sqlite-vec). Simple, local, inspectable. An LSM store
(LevelDB/RocksDB, or a small hand-built one) was considered: it's built
for heavy write rates, which this doesn't have (a few exchanges a minute),
and it has no keyword or vector search, so those would have to be built
on top. It stays a possible learning side quest behind the same interface
([[Key Value Store]]).

## Models

All local, on an M2 with 8 GB RAM.

| Job | Model | Why |
|---|---|---|
| Embeddings (search) | Qwen3-Embedding-0.6B via Ollama | Best open model at its size; ~640 MB; ~1.4k tokens/s here |
| Labels: decision, unresolved, topic | Embedding probe: logistic regression on the Qwen3 vectors | Beat Laya on all three; ~1 ms on top of the embedding; no second model |
| Query intent (CLI, Clance) | Laya + rules | Laya wins on paraphrased intents; rules win on structural ones |
| Reranker (optional) | Qwen3-Reranker-0.6B or a bge-reranker | Only if the eval shows a gain |
| Answers in `ask()` | An LLM via API | The one place text leaves the machine |

## Findings that shape the design

Each links to the full write-up in [[experiments]].

- **The data.** 481 transcripts, 773 MB, 69 project folders. Conversation
  text is ≈3.5M tokens; tool output ≈43M (12× more, mostly noise for
  recall). ≈69k new conversation tokens per day.
- **Session folders don't identify projects.** Half the sessions (169)
  run from `~/.clance`, Clance's chat home, and cover every project; 196
  more are in the Clance repo. The folder is a weak project signal, so
  project has to come from content too (pointers, embeddings).
- **Exchange sizes.** 4,050 exchanges: median 316 tokens, p90 1.1k, p99
  11.9k, max 67k. 30% of user messages are under ~15 tokens ("yes", "do
  it"), which is why each chunk carries the end of the previous reply: a
  decision is often a proposal in one exchange and a "yes" in the next.
- **Pointers are plentiful.** 7,139 file-path mentions (1,049 distinct),
  2,055 URLs, ~1,500 SHA-like strings, 629 PR/issue refs; 246 file names
  appear in 2+ sessions. Enough to link sessions without any model.
- **Embedding on this machine is practical.** 200 real exchanges in 178 s
  (~1.4k tokens/s, peak ~1.5 GB); full backfill ~50 min once; ongoing
  under a minute a day; a query embeds in ~21 ms.
- **Labels: a trained probe beats Laya zero-shot on all three.** On 300
  exchanges labelled by Claude (blind second labeller: κ 0.88–0.94):
  decision AUC 0.68 vs. 0.58, unresolved 0.64 vs. 0.52, topic accuracy
  0.52 vs. 0.37. Laya's own model card calls the base checkpoints "a fast
  base to specialise, not a zero-shot decision engine". The probe's
  quality is modest: good for boosting, not for filtering.
- **Query understanding: rules and Laya fail in opposite places.** On 119
  realistic queries: rules 0.67 intent, Laya 0.66, but rules are perfect
  on refs and weak on decision/open (0.38); Laya is 0.75 on decision/open
  and weak on refs. Combined: 0.79 (chosen after seeing the data, so not
  yet confirmed). For project, rules never invent one but miss misheard
  names; embeddings catch those but always guess something.
- **First real ingest (2026-10-16).** 404 logs read in 3.7 s: 3,831
  exchanges in 396 sessions; 2,125 of them (55%) from `.clance`, 1,342
  from the Clance repo. A re-run reads only logs that changed and appends
  nothing it already has. Full backfill embedded 3,831 exchanges as
  5,727 chunks; the store is 80 MB. It took 2 h 38 min of wall-clock time
  (rate at the end: 1.75 exchanges/s, which predicts ~40 min, so most of
  the gap is likely the machine sleeping or busy; later exchanges are also
  longer). A one-time cost; resumable.
- **First real searches (2026-10-16).** Relevant results across sessions
  (a disk-space question found today's session and two from September),
  with four weaknesses: (1) **forked sessions duplicate history**, so the
  same exchange returns twice, since the hash includes the session id;
  (2) **decisions don't rank first** ("why did we pick sqlite" surfaced a
  long docs reply and old interview talk, not the "sqlite is fine"
  moment), the case for label boosting; (3) **project is `.clance` for
  most results**, so project from content matters in practice; (4)
  **snippets show an exchange's start, not the part that matched**.
- **Labels and pointers on the real history (2026-10-17).** Probes
  trained on stored vectors: decision AUC 0.71, unresolved 0.64, topic
  0.51. Their scores cluster around 0.5 (median p_decision 0.47, p90
  0.68), so the decision boost barely moves rankings; the one real query
  checked didn't improve. Pointers: 9,189 from 1,690 exchanges; `refs` and
  `related` work as intended.
- **Retrieval eval v1 (2026-10-17).** 146 checked questions written from
  random target exchanges: hybrid R@5 0.88, R@10 0.98, MRR 0.72; the
  target's session is in the top 5 for 0.99. Hybrid beats keyword (0.80)
  and vector (0.83) alone. The label boost gives no gain (decision R@5
  0.81 vs. 0.86, 2 of 37, within noise). Optimistic: questions were
  written looking at the target.
- **Tuning and reranking (2026-10-17).** On a tune/test split of the
  eval, no setting of pool size, RRF constant, list weights, label boost
  or chunk size beat the defaults (pool 50, k 60, equal weights, Qwen3
  query instruction, 4,000-char chunks). A **cross-encoder reranker**
  (bge-reranker-v2-m3 over the top 30) is the first clear win: test R@1
  0.58 → 0.77, MRR 0.71 → 0.84. It costs ~5 s per query on the M2.
- **A fast reranker fits the bar (2026-10-18).** bge-reranker-base over
  the top 10 at 512 tokens takes ~0.6 s on the M2 and lifts test R@1 0.58
  → 0.75, MRR 0.71 → 0.81 (the 5 s big model reached 0.84). MiniLM does
  0.08 s at test MRR 0.79. 512 tokens beats 256; 10 candidates beats 20.
- **The agent is the ceiling.** A Claude labeller understood 119/120
  queries. In Claude Code the agent does step 1 itself.

## Decisions

| Decision | Why |
|---|---|
| Library first; MCP and CLI are adapters | Usable from any interface, including Clance |
| Watcher with append-only store, indexing on append | Index always fresh; store is the source of truth |
| No background LLM writing; an LLM only writes answers | Faithfulness; nothing runs that wasn't asked for |
| Everything that indexes runs locally; no Jev (2026-10-16) | Conversation text never leaves the machine for indexing |
| Exchanges and enrichments keyed by content hash | Idempotent ingest, dedup, stable labels |
| Conversation text only, never tool output | 12× less data, less noise, fewer secrets |
| One SQLite file: append-only tables + FTS5 + sqlite-vec, behind a `Store` interface | Low write rate; keyword and vector search built in; local; swappable |
| Qwen3-Embedding-0.6B, local, pluggable | Best quality that fits 8 GB; benchmarked at ~50 min backfill |
| Contextual chunks: header + previous-reply tail + exchange | Chunks keep their meaning; short "yes" replies carry their proposal |
| Split long exchanges on purpose, with overlap | Smaller chunks match more precisely; one vector for a long exchange blurs its topics |
| v1 labels: decision, unresolved, topic; preference later | Map to "what did we decide", "what's still open", and filtering |
| Laya zero-shot rejected as the exchange labeller | Lost to the embedding probe on all three labels |
| Laya for query intent in the CLI and Clance, with rules (confirmed 2026-10-16) | Its strength is paraphrased intents, with options set per request; without it, paraphrases fall back to plain similarity |
| Pointers as a deterministic enricher and link graph | Exact lookups and related sessions for free; GraphRAG-style expansion to test |
| Intent decides which index leads and which label boosts | One query layer serves all five question types |
| A background service (cairnd) with thin clients (CLI, dashboard, MCP) | Models stay warm (Laya loads in seconds); one writer to SQLite; one place holding memory |
| Sources are plug-ins per coding agent; Claude Code first, Codex next | Harness-agnostic; the core only sees normalised exchanges |
| **Node everywhere by default (2026-10-18):** reranker = MiniLM-L6 via ONNX in Node; Laya via `laya-ts` (ONNX in Node) if it passes its measurement, otherwise an optional Python sidecar for CLI free-text intent only | Install is Node + Ollama; ~1 GB less memory than the Python GPU route on an 8 GB machine; one runtime to build, test and ship; the Python route's edge is Mac-GPU-specific and worth ~0.02 MRR |
| The Python GPU reranker (bge-reranker-base) is at most a later opt-in "quality mode" | +0.02 test MRR doesn't justify Python, a second process and ~1 GB as the default |
| Laya loaded lazily and unloaded when idle | 8 GB machine; MCP queries rarely need it |
| Distributed via npm and the author's Homebrew tap | Same path as Clance; brew pulls in Node, Ollama and uv |
| Reranker and link expansion optional, kept only if the eval shows a gain | Each adds latency; earn it with data |
| LLM notes only if the retrieval eval says decisions are missed | Decide with data; adds generated text |

## Build order

1. **Search:** transcript parser, store, watcher and backfill, keyword +
   vector index, `search` in the CLI. Useful on day one.
2. **Pointers**, `refs` and related sessions; **labels** (embedding probe)
   and label boosting. Built 2026-10-17; the boost needs tuning (step 4).
3. **The rest, in this order (decided 2026-10-18):** (a) **cairnd** and
   the watcher, with the CLI as a thin client; (b) **open, brief, ask**;
   (c) **`cairn init`**; then (d) the **MCP server** and (e) **Laya** for
   query understanding. Codex support much later. See [[packaging]].
   (a) built 2026-10-18: `cairn daemon`, `cairn service start|stop|status`
   (launchd), JSON-RPC over `~/.cairn/cairnd.sock`, the CLI as a thin
   client with an in-process fallback; `cairn live` shows its status and
   activity as it happens.
4. **Retrieval eval:** labelled questions with known answer sessions;
   tune chunking, fusion, boosts, the reranker and link expansion against
   it. Labels drafted by an LLM and checked by a second, blind LLM
   labeller. v1 built 2026-10-17 (`npm run eval:retrieval`); tuning
   experiments next.

## Open questions
- [ ] **Label model quality.** The probe leads but is modest (AUC
      0.64–0.68, topic 0.52). Options: (a) distil ~1,500 more labels and
      watch the probe's learning curve; (b) fine-tune Laya on the same
      labels on a free GPU (its notebook targets Kaggle T4s) and compare
      with the probe on equal terms; (c) ship v1 without label boosting
      and add it once a model is good enough.
- [ ] **Confirm the query-understanding combination** (rules for refs and
      aliases, Laya for paraphrased intents, embeddings for misheard
      projects) on a fresh query set, since it was chosen after seeing
      the first one.
- [x] **Fork and resume duplicates.** 38 exchanges were copied across 8
      sessions, identical in timestamp and text. Each exchange now has a
      `content_key` (hash of timestamp + user text + reply, without the
      session): ingest skips copies, and search shows each key once, which
      also covers copies stored before the fix. Trade-off: a result is
      credited to whichever copy ranks first, and a new fork's session
      doesn't hold its pre-fork history (the original does). Done
      2026-10-16.
- [x] **Snippets:** keyword hits show FTS5's matching fragment; vector
      hits show the start of the closest chunk. Done 2026-10-16.
- [x] **Snippet noise:** the keyword index has two columns: `text` (the
      conversation) and `meta` (project, session name, files, commits).
      Both are searched; snippets come from `text` only, and when the match
      is only in `meta` the closest chunk is shown instead. Older stores
      rebuild the index on open. Done 2026-10-16.
- [ ] **Project from content.** Since folders don't identify projects for
      most sessions, infer it per exchange (pointers' repo paths,
      embedding similarity to project descriptions)?
- [ ] **Secrets in `ask()`:** scrub known key formats from passages before
      they go to the LLM?
- [ ] **Exchange completeness** during long agentic turns, and the target
      chunk size for splitting (set by the eval).
- [ ] **Subagent and sidechain transcripts:** 87 nested subagent logs are
      skipped in v1. Include them, and link them to the parent session?
- [ ] **Conversation branches:** entries form a tree (`parentUuid`); edits
      and rewinds branch it. v1 reads file order. Follow only the active
      branch?
- [ ] **Where the watcher runs:** `cairn watch` as a long-running process,
      launchd, or inside the MCP server process.
- [ ] **Pool tied to limit:** search's candidate pool is `max(50, limit ×
      5)`, so a larger `--limit` changes which candidates are fused (pool
      150 was slightly worse in the grid). Decouple pool from limit.
- [ ] **Ranking:** fusion method, candidate pool size (50 per list today;
      a target ranked 59th by vector was cut), and how labels boost.
      Probe scores cluster near 0.5, so a multiplicative (1 + p) boost is
      weak; options include boosting by percentile within the candidates.
      Tune against the retrieval eval, not single queries. Eval v1: the
      boost gives no gain, so it adds nothing until the probes improve.
- [ ] **A label model for other users.** The probes are trained on the
      author's labelled exchanges and live in `~/.cairn/models/`, not the
      repo. A fresh install has no label model, so labels are off. Ship a
      default trained on shareable data, or let users label a sample?
- [ ] **Path pointers:** a bare name ("jev.ts") and its full path count as
      two targets in `related`; edits made from a cwd outside the repo
      (e.g. `~/.clance`) keep absolute paths. `refs` matches by suffix, so
      lookups work; counting and display don't unify them yet.
- [ ] **Pointer normalisation:** relative vs. absolute paths per project
      root; telling real SHAs from other hex strings (check against git?).
- [ ] **Reranker: adopt it, and how?** bge-reranker-v2-m3 over the top 30
      lifts test MRR 0.71 → 0.84 but takes ~5 s per query on the M2.
      **The author's call (2026-10-17): 5 s is too long; reranked search
      must meet the same under-a-second target as search.**
      **Fast-reranker result (2026-10-18):** over the top 10 at 512 tokens,
      bge-reranker-base reaches test MRR 0.81 at ~0.6 s and MiniLM-L6 0.79
      at 0.08 s, both measured with PyTorch on the Apple GPU. In Node via
      ONNX on the CPU, bge-reranker-base takes 1.3 s (int8), over the bar
      ([[experiments]]).
      **Decided (author, 2026-10-18): MiniLM-L6 via ONNX in Node**, as
      part of "Node everywhere" (see Decisions), provided its Node latency
      is ≲ 0.3 s. **Measured: passes** at int8, 512 tokens, 4 threads:
      0.32 s p50, 0.44 s p95, test MRR 0.79 (tune 0.78), the same as full
      precision; 256 tokens gives 0.17 s for −0.02 MRR ([[experiments]]).
      **Wired in (2026-10-18):** `search()` reranks the top 10 when given a
      reranker; the CLI has `--rerank`. End to end: test MRR 0.71 → 0.79;
      a reranked search takes ~0.4 s inside a process, ~0.6 s from the
      built CLI. **On by default (author, 2026-10-18);** `--no-rerank`
      skips it, and if the reranker can't load (e.g. offline before its
      first download) search answers without it. Still open: the worker
      thread, which matters once cairnd exists; the CLI runs it in
      process. Node
      only, no Python; ~23 MB int8 and ~100–200 MB in memory, against ~1 GB
      for bge-reranker-base; it gives up ~0.02 test MRR (0.79 vs. 0.81;
      0.04 on tune, ~3 of 60 more answered first for bge). bge-reranker-base
      would need the Apple GPU through a Python sidecar to meet the bar, so
      it stays a possible opt-in "quality mode". Open: MiniLM's latency in
      Node on the CPU (unmeasured); run it in a `worker_thread` inside
      cairnd so inference never stalls the service (ONNX Runtime uses its
      own native thread pool; whether a run blocks Node's event loop
      depends on the binding version); on by default or a flag; confirm on
      real queries.
- [x] **Language/runtime:** TypeScript on Node 22+ for the service, CLI,
      dashboard and MCP; label probes evaluated in TypeScript from saved
      weights; Laya as a Python sidecar (`laya-serve`). Decided 2026-10-16
      ([[packaging]]).
      **Revised 2026-10-18: Node everywhere by default.** Laya moves to
      `laya-ts` (ONNX in Node) if it passes: CPU latency ≲ 0.5 s per
      question and the same answers as the Python package on the query
      intent set. If it fails, Laya stays an optional Python sidecar,
      used only for free-text intent in the CLI; MCP clients never need
      it.
