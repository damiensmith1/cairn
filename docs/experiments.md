---
title: Experiments
tags: [cairn, experiments, evals]
status: active
---

# Experiments

Spikes run to settle [[design]] questions with data. Newest first. Raw
data (conversation excerpts, labels, scores) stays outside the repo in
`~/.cairn/spikes/`, since it's the author's own conversations.

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
