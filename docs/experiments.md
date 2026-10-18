---
title: Experiments
tags: [cairn, experiments, evals]
status: active
---

# Experiments

Spikes run to settle [[design]] questions with data. Newest first. Raw
data (conversation excerpts, labels, scores) stays outside the repo in
`~/.cairn/spikes/`, since it's the author's own conversations.

## 2026-10-17 · Reranker: bge-reranker-v2-m3 on hybrid's top 30

**Setup.** For each of the 146 checked questions, hybrid search (pool 150)
returns its top 30 exchanges; a cross-encoder (BAAI/bge-reranker-v2-m3,
568M, via sentence-transformers on the Apple GPU, max 512 tokens) reads
the question with each candidate's text (user + reply, first 1,500 chars)
and reorders them. Same tune/test split as the tuning grid. Scripts:
`npm run eval:retrieval -- dump-rerank | rerank` plus
`~/.cairn/spikes/rerank.py`.

| | tune R@1 | R@5 | R@10 | MRR | sess5 | test R@1 | R@5 | R@10 | MRR | sess5 |
|---|---|---|---|---|---|---|---|---|---|---|
| Current search (pool 50) | 0.62 | 0.90 | 0.99 | 0.72 | 0.98 | 0.58 | 0.87 | 0.97 | 0.71 | 1.00 |
| Hybrid top 30 (pool 150, the reranker's input) | 0.62 | 0.84 | 0.91 | 0.70 | 0.92 | 0.58 | 0.82 | 0.92 | 0.70 | 0.95 |
| **+ reranker** | **0.67** | **0.94** | **0.98** | **0.79** | **0.99** | **0.77** | **0.93** | **0.95** | **0.84** | **0.98** |

**Latency** on the M2: p50 5.1 s, p95 9.4 s per query for 30 candidates
(the run spanned a laptop sleep; the one query that included it, 1,983 s,
is the maximum, so it affects neither p50 nor p95).

**Findings**
- **The first change that beats the baseline beyond noise**, on both
  halves: test R@1 0.58 → 0.77 (about 11 more questions answered first),
  MRR 0.71 → 0.84; tune MRR 0.72 → 0.79. It mostly fixes *ranking*: the
  right exchange was usually among the 30 already.
- **Too slow as is for interactive use** on this machine (~5 s). Levers:
  fewer candidates (top 10–15), shorter candidate text, a smaller
  cross-encoder (bge-reranker-base, Qwen3-Reranker-0.6B, MiniLM), ONNX.
  Inside an agent (MCP), a few seconds is tolerable.
- **Caveat:** questions were written looking at the targets, and a
  cross-encoder reads full text, so it benefits from shared wording too.
  The gain is large enough to survive a discount, but a real-query set
  would confirm it.
- **Practical notes:** the first attempt hung for ~7 h when the laptop
  slept mid-run (no network timeout in the model download); fixed by
  running offline with progress logging. Memory: another ~2.3 GB model on
  an 8 GB machine, next to Qwen3 embeddings.

## 2026-10-17 · Retrieval tuning: pool, fusion, query instruction, boosts, chunk size

**Method.** The 146 checked questions from retrieval eval v1, split by the
target's session (hash parity) into a **tune** half (86) and a **test**
half (60). Configurations are chosen on tune and confirmed on test, so the
grid doesn't just fit these questions. One question is worth ~0.012 on
tune and ~0.017 on test; differences of a few hundredths are noise.
`npm run eval:retrieval -- experiments`.

| Configuration | tune R@1 | R@5 | R@10 | MRR | test R@1 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|---|---|
| **Baseline: hybrid, pool 50, RRF k 60, equal weights** | 0.62 | 0.90 | 0.99 | 0.72 | 0.58 | 0.87 | 0.97 | 0.71 |
| Pool 150 | 0.62 | 0.90 | 0.97 | 0.72 | 0.58 | 0.83 | 0.93 | 0.70 |
| Pool 300 | 0.62 | 0.90 | 0.97 | 0.72 | 0.58 | 0.83 | 0.95 | 0.70 |
| RRF k 20 | 0.63 | 0.91 | 0.99 | 0.74 | 0.60 | 0.87 | 0.93 | 0.71 |
| RRF k 120 | 0.62 | 0.87 | 0.99 | 0.72 | 0.58 | 0.87 | 0.97 | 0.71 |
| Weights keyword 1 : vector 2 | 0.53 | 0.87 | 0.95 | 0.67 | 0.57 | 0.85 | 0.95 | 0.68 |
| Weights keyword 2 : vector 1 | 0.63 | 0.85 | 0.99 | 0.72 | 0.58 | 0.82 | 0.95 | 0.70 |
| No query instruction (Qwen3) | 0.56 | 0.80 | 0.97 | 0.67 | 0.62 | 0.88 | 0.95 | 0.72 |
| Label boost, multiply 1.0 | 0.60 | 0.87 | 0.98 | 0.71 | 0.53 | 0.87 | 0.97 | 0.68 |
| Label boost, multiply 0.3 | 0.63 | 0.88 | 0.99 | 0.74 | 0.57 | 0.87 | 0.97 | 0.71 |
| Label boost, percentile 0.3 | 0.56 | 0.86 | 0.95 | 0.68 | 0.53 | 0.85 | 0.95 | 0.67 |
| Label boost, only if p ≥ 0.7 | 0.56 | 0.88 | 0.97 | 0.68 | 0.50 | 0.83 | 0.93 | 0.64 |

Session R@5 was 0.98–1.00 everywhere except "no query instruction" on
tune (0.93).

**Chunk size** (the store re-embedded with 2,000-char chunks, 9,210
chunks instead of 5,727):

| Chunks | tune R@1 | R@5 | R@10 | MRR | test R@1 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|---|---|---|
| **4,000 chars (current)** | 0.62 | 0.90 | 0.99 | 0.72 | 0.58 | 0.87 | 0.97 | 0.71 |
| 2,000 chars | 0.59 | 0.85 | 0.97 | 0.71 | 0.55 | 0.83 | 0.95 | 0.68 |

**Findings**
- **Nothing beat the baseline.** The best tune results (RRF k 20 and a
  0.3 multiply boost, MRR 0.74, about two questions) didn't hold on test
  (0.71, same as baseline). Defaults stay as they are.
- **A bigger candidate pool doesn't help** and slightly hurts on test:
  more weak candidates get through fusion. The "sqlite is fine" miss
  (vector rank 59) is the exception, not the pattern.
- **Equal weights are right**; tilting either way loses.
- **Keep Qwen3's query instruction**: without it, tune drops clearly (MRR
  0.67, session R@5 0.93); test is flat.
- **No label boost variant helps.** Confirms the probes aren't good
  enough to steer ranking yet.
- **Smaller chunks are worse** on both halves. 4,000 chars stays.
- The grid ran while the store copy was being re-embedded and across a
  laptop sleep (~6 h wall clock); that affects time only, not results.

## 2026-10-17 · Retrieval eval v1

**Question:** does search find the exchange a realistic question is about,
and which configuration does it best?

**Data.** 150 target exchanges sampled at random (seed 17) from the 3,120
substantive ones (reply ≥ 150 chars), excluding the 296 the label probes
were trained on and fork copies. For each, an agent wrote the question the
developer would ask weeks later to find it (dictation style, paraphrased,
a third deliberately vague) and chose its intent: 93 recall, 38 decision,
19 open. A blind checker confirmed the target answers its question for
146; 4 dropped. Runner: `npm run eval:retrieval -- run`; data and results
in `~/.cairn/evals/retrieval/`.

A hit is the target, a fork copy of it, or its neighbour in the same
session. Session R@5 counts the target's session among the top 5.

| Configuration | R@1 | R@5 | R@10 | MRR | Session R@5 |
|---|---|---|---|---|---|
| Keyword only | 0.55 | 0.80 | 0.90 | 0.67 | 0.95 |
| Vector only | 0.51 | 0.83 | 0.88 | 0.64 | 0.95 |
| **Hybrid (RRF)** | **0.60** | **0.88** | **0.98** | **0.72** | **0.99** |
| Hybrid + label boost | 0.58 | 0.87 | 0.97 | 0.70 | 0.99 |

By intent, R@5 hybrid vs. boosted: decision 0.86 vs. 0.81 (n = 37),
open 0.88 vs. 0.88 (16), recall 0.89 vs. 0.89 (93).

**Findings**
- **Hybrid beats either half** on every measure: keyword and vector find
  different things, and fusion keeps both.
- **The label boost doesn't help.** On decision questions it's 0.81 vs.
  0.86, which is 2 questions out of 37, so within noise: "no gain" rather
  than "a loss". It matches the probes' weak separation (scores cluster
  near 0.5).
- **Finding the right session is nearly solved** (0.99 in the top 5); the
  remaining work is ranking the exact exchange first (R@1 0.60).

**Caveats.** Questions were written by an LLM looking at the target, so
they share more words with it than a real memory-based question would,
even paraphrased: these numbers are optimistic, keyword search most of
all. 146 questions, 37 for decisions: differences under ~5 points are
noise. A real-query set (questions the author actually asks) is the next
level of evidence.

## 2026-10-17 · Label probes on stored vectors, and the first boost check

**Training.** The probes were re-trained in TypeScript (logistic and
softmax regression, L2, balanced class weights, Adam) on the vectors cairn
stores (the mean of each exchange's chunk vectors), from the spike's
labels: 284 of 300 labelled exchanges matched a stored exchange. Grouped
5-fold CV by session: **decision AUC 0.71, unresolved AUC 0.64, topic
accuracy 0.51**, in line with the spike (0.68 / 0.64 / 0.52), which
validates the TypeScript trainer. Training takes ~25 s; labelling all
3,840 exchanges a few seconds.

**The boost on a real query is too weak.** "why did we pick sqlite for
cairn" (asked as a decision search) still didn't surface the "sqlite is
fine" exchange: retrieval ranked it 37th (keyword) and 59th (vector,
outside the 50-candidate pool), and the probe gave it p(decision) 0.54
against a median of 0.47 and a 90th percentile of 0.68. Probe scores
cluster around 0.5, so multiplying by (1 + p) lifts nearly everything a
little. Not tuned on this one query: that would be overfitting. The
retrieval eval (build step 4) is where boost strength, candidate pool size
and the label model get tuned.

**Pointers.** 9,189 pointers from 1,690 of 3,840 exchanges. `refs` finds
edits and mentions in order (including mentions made as examples);
`related` ranks sessions by shared targets.

## 2026-10-16 · Query understanding: intent + project (rules vs. embeddings vs. Laya)

**Question:** Laya lost as an exchange labeller. Does it earn a job reading
the *search query* instead, where questions and options change per request
(its design strength)? Matters for the CLI and Clance; inside Claude Code
the agent already understands the query.

**Data.** 120 realistic queries (24 per intent: decision, open, recall,
find_session, refs; 70% naming a project, often indirectly or misheard:
"prompt tuna", "lowed", "lb playground") written by one agent, labelled
blind by another: intent 119/120, project 120/120 agree; the 1
disagreement dropped, leaving 119. Rules were written before the queries
existed. Projects: 19 options (18 projects + none), passed at query time.

| Method | Intent acc | Intent macro-F1 | Project acc | Project acc (named only) |
|---|---|---|---|---|
| Keyword rules (regex intents, project aliases) | **0.67** | **0.68** | **0.88** | 0.83 |
| Embeddings (intent probe, CV; project by similarity) | 0.61 | 0.60 | 0.67 | **0.89** |
| Laya English | 0.66 | 0.66 | 0.70 | 0.72 |
| Laya multilingual | 0.58 | 0.56 | 0.71 | 0.80 |

Latency on the M2: Laya English ~340 ms per query, multilingual ~140 ms.

**Where each one fails**
- **Intent:** rules are perfect on refs (1.00) and good on recall (0.91)
  but weak on decision and open (0.38 each), where phrasing varies. Laya
  is the reverse: 0.75 on decision and open, 0.33 on refs. Only 15 of 119
  are wrong for both. **refs-by-rule, otherwise Laya: 0.79**, but that
  combination was chosen after seeing these results, so it needs fresh
  queries to confirm.
- **Project:** rules never invent a project for "none" queries (1.00) but
  miss misheard or indirect names ("prompt tuna", "fraud code", "bakery
  site"). Embedding similarity catches those (0.89 on named) but always
  picks *some* project (0.17 on "none"). Laya sits between.

**Findings**
- Laya does have a niche here: **intent for paraphrased decision/open
  queries**, where it beats rules by a wide margin. It doesn't win
  overall on its own.
- The strongest design is a combination: rules for structural intents
  (refs) and exact aliases, a model for the paraphrased rest, embeddings
  for misheard project names with a cut-off for "none".
- The ceiling is high: a Claude labeller matched the writer on 119/120.
  In Claude Code, the agent does this itself; this only matters for the
  CLI and Clance.

## 2026-10-16 · Topic and unresolved labels: Laya zero-shot vs. an embedding probe

**Question:** the v1 label set is decision, unresolved and topic. Does
Laya, the planned local replacement for Jev, do better on the other two
than it did on decision?

**Data.** The same 300 windows, labelled by three Claude labellers from a
second guideline (`guideline_topic_unresolved.md`): topic is one of nine
(building 67, career 55, design 47, learning 45, other 24, release 20,
docs 19, debugging 15, setup 8); unresolved is 72 yes, 211 no, 17 unsure.
A blind fourth labeller re-did 60: **topic 57/60 (κ 0.94), unresolved
57/60 (κ 0.88)**. Reliable labels.

**Topic** (9 classes, 300 items):

| Method | Accuracy | Macro-F1 |
|---|---|---|
| Baseline: always "building" | 0.22 | 0.04 |
| Laya English, 9-option choice | 0.37 | 0.36 |
| Laya multilingual | 0.20 | 0.21 |
| **Embedding probe** (multinomial logistic regression, CV by session) | **0.52** | **0.47** |

**Unresolved** (283 items, prevalence 0.25):

| Method | AUC | PR-AUC |
|---|---|---|
| Baseline: question marks in the user's message | 0.57 | 0.29 |
| Laya English, choice / yes-no | 0.52 / 0.52 | 0.25 / 0.26 |
| Laya multilingual, choice / yes-no | 0.42 / 0.46 | 0.22 / 0.23 |
| **Embedding probe** | **0.64** | **0.37** |

**Findings**
- **Laya zero-shot loses on all three labels.** English is above chance
  only on topic (0.37 vs. 0.22); on unresolved it's at chance, and the
  multilingual checkpoint is at or below chance everywhere.
- **The embedding probe wins all three**, trained on only ~240 examples
  of this data per fold. A small model trained on your own data beats a
  bigger general model used zero-shot.
- **Absolute quality is still modest** (topic 0.52 accuracy; decision 0.68
  and unresolved 0.64 AUC). Enough to boost ranking, not to filter on.
- The common lever for both options is **more labelled data**: it would
  train a better probe and is exactly what fine-tuning Laya needs.

## 2026-10-16 · Decision labels: Laya zero-shot vs. an embedding probe

**Question:** with Jev ruled out (labels must run locally), what can
detect "a decision was made in this exchange" on this machine (M2, 8 GB)?

**Data.** 300 random exchanges from all sessions (seed 11), each cut to
its decision moment: the end of the previous reply, the user's message
and the start of the reply (≤ ~1.9k chars). Labelled yes / no / unsure by
three Claude labellers working from a written guideline
(`~/.cairn/spikes/decisions/guideline.md`): **94 yes, 201 no, 5 unsure**
(prevalence 0.32). A fourth, blind labeller re-labelled 53 of them:
**50/53 agree, κ 0.88**, so the answer key is reasonably solid.

**Candidates**, scored on the 295 non-unsure items:

| Method | AUC (95% CI) | PR-AUC | Cost per item |
|---|---|---|---|
| Baseline: short user reply right after a question | 0.57 [0.52, 0.62] | 0.36 | free |
| Laya English (ModernBERT-large), 2-option choice | 0.58 [0.50, 0.64] | 0.38 | ~0.5 s |
| Laya English, yes/no (`noul`) | 0.52 [0.44, 0.58] | 0.32 | ~0.5 s |
| Laya multilingual (mmBERT-base), choice | 0.53 [0.46, 0.59] | 0.34 | ~0.2 s |
| Laya multilingual, yes/no | 0.57 [0.50, 0.64] | 0.36 | ~0.2 s |
| **Embedding probe:** Qwen3-Embedding-0.6B + logistic regression, 5-fold CV grouped by session | **0.68 [0.62, 0.74]** | **0.50** | ~1 ms after embedding |

PR-AUC at random is the prevalence, 0.32.

**Findings**
- **Laya zero-shot is near chance and no better than a one-line
  heuristic.** This matches its own model card ("a fast base to
  specialise, not a zero-shot decision engine"). Rejected as-is.
- **The embedding probe is clearly better** and nearly free, since every
  exchange is embedded anyway. But 0.68 is modest: good enough to *boost*
  ranking, not to filter on.
- The probe trained on only ~236 examples per fold. More labels are the
  obvious next lever.

**Setup notes.** Laya 0.4.8 in an isolated `uv` venv (795 MB with
PyTorch; weights ~0.8 GB English, ~0.65 GB multilingual). `laya.load`
downloads only safetensors, config and tokenizer files; the `.py` files
in the model repo are never fetched or run. Apple GPU (MPS) used.

**Open:** see "Label model" in [[design]].

## 2026-10-16 · Embedding model on this machine

**Question:** what's the best local embedding model that fits an M2 with
8 GB RAM, and is a full backfill practical?

**Candidates** (2026 rankings checked; benchmark numbers differ between
sources, so treat them as rough): Qwen3-Embedding 0.6B / 4B / 8B, bge-m3,
nomic-embed-text, mxbai-embed-large. The 4B and 8B don't fit 8 GB
comfortably. Chosen to start: **Qwen3-Embedding-0.6B** (strongest at its
size; ~640 MB; 32K context; Apache 2.0). bge-m3 and nomic-embed-text stay
as comparisons for the retrieval eval.

**Benchmark** (Ollama 0.34.3): 200 random real exchanges prepared as
designed (header + previous-reply tail, ~1k-token chunks, 15% overlap):
341 chunks, 246k tokens in **178 s**: ~1,400 tokens/s, 1.9 chunks/s,
1024-dim vectors, peak Ollama memory **~1.5 GB**. Extrapolated full
backfill (4,055 exchanges, 16M chars): **~50 min**, once, resumable.
Ongoing (~69k tokens/day): under a minute a day. A search query embeds in
**~21 ms** with the model loaded.

**Note on context length:** a long-context model doesn't mean better
retrieval; one vector for a long, multi-topic exchange blurs it. Long
exchanges are split on purpose for precision.

## 2026-10-16 · The data

Measured over `~/.claude/projects/*/*.jsonl`:

- 481 transcripts, 773 MB. Conversation text ≈14M chars (≈3.5M tokens);
  tool calls and results ≈172M chars (≈43M tokens).
- 4,043 typed user prompts over 41 active days; ≈69k new conversation
  tokens/day over the last 30 active days (max 302k).
- **Sessions by folder:** 196 in the Clance repo (glance, worktrees
  merged), 169 in `~/.clance` (Clance's chat home, covering every
  project), then a long tail (fantasy-lab 5, mp3compressor 4, logger 4,
  …). The folder is a weak project signal for most sessions.
- **Exchanges:** 4,050; median 316 tokens, p90 1.1k, p99 11.9k, max 67k;
  1,207 over 512 tokens, 55 over 8k. 30% of user messages are under ~15
  tokens.
- **Free signals:** 397 git commits made from sessions, 2,381 file edits,
  19 compaction summaries.
- **Pointers in conversation text:** 7,139 file-path mentions (1,049
  distinct), 2,055 URLs (955 distinct), ~1,500 SHA-like strings (703
  distinct, some false hits), 629 PR/issue refs (81 distinct); 246 file
  names appear in 2+ sessions.
