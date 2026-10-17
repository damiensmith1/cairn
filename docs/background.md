---
title: Background
tags: [cairn, background]
status: draft
---

# Background

See [[requirements]] for what it must do and [[design]] for how.

## The problem

I run a lot of agent sessions, often several at once across many projects.
Decisions, reasoning and context end up spread across hundreds of
conversations, and after a few days they're effectively lost:

- **"What did we decide about X?"** The decision was made in some session,
  maybe last week, maybe in a different project. Finding it means guessing
  which session and scrolling.
- **"Remember when we talked about X? Tell me more."** The discussion
  exists, but there's no way to search for it.
- **"Bring that context into this session."** Some sessions hold exactly
  the context a new session needs. Today that context has to be retyped
  or re-derived.

Claude Code's `--resume` picker lists sessions by name, but there's no way
to search what was said or decided inside them.

## The data already exists

Claude Code saves every session as an append-only JSONL log under
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Measured on
2026-10-16:

| | |
|---|---|
| Session transcripts | 481 files, 773 MB, 69 project folders |
| Conversation text (user + assistant text) | ≈14M chars, ≈3.5M tokens |
| Tool calls and results | ≈172M chars, ≈43M tokens |
| Typed user prompts | 4,043 over 41 active days |
| New conversation text | ≈69k tokens/day on average (last 30 active days), 302k max |

Tool output is about 12× the size of the conversation and mostly noise for
recall (file contents, logs, diffs). The conversation is what matters.

The logs also carry signals that need no AI at all:

| Signal | Count |
|---|---|
| Git commits made from inside sessions (commit messages are human-quality summaries of outcomes) | 397 |
| File edits (Edit/Write tool calls), so "files touched" is free | 2,381 |
| Compaction summaries Claude Code already wrote | 19 |
| Session names, project folders, timestamps | every session |

## What cairn is

A cairn is a stack of stones that marks a trail you've walked, so you can
find your way back. cairn does that for agent sessions: it watches them,
keeps every exchange in an append-only store, indexes it by words, meaning
and local labels, and lets you search and pull context back into any new
session. Every result is the verbatim conversation with a link to its
source.

It is a library first. An MCP server and a CLI are thin adapters over it,
and other tools (Clance) can import it directly.

## Principles

- **Faithful.** Search returns what was actually said, with its source.
  Generated text never replaces the record.
- **No background summarising.** An LLM writes text only to answer a
  question you asked, from the passages just retrieved. Indexing labels
  and embeds; it doesn't write.
- **Append-only.** The store is only ever added to. Indexes are derived
  from it and can be rebuilt from it.
- **Local.** The store lives on this machine. What leaves it is limited to
  the enrichers you configure (see [[requirements]]).

## Why it's also a learning project

It's meant to be used daily and to teach, in one codebase:

- **RAG done properly:** chunking conversations, embeddings plus keyword
  search, fusion, reranking, citations.
- **Event logs and append-only stores:** transcripts are read
  incrementally like an event log; the store follows "all updates are
  commits". See [[Event Sourced - Log-Structured Stores]] and
  [[CQRS (Command Query Responsibility Segregation)]]: the store is the
  write model, the indexes are read models.
- **Content addressing:** every exchange and every derived record is keyed
  by hash, so re-ingesting is idempotent and only new content is processed
  ([[Retry Semantics and Idempotency]]).
- **Structured outputs:** typed enrichments validated against a schema.
- **Evals:** "did search find the right session?" is a clean retrieval
  eval.

These overlap with ideas in the Console One whitepaper (commits as the only
way to change state, content-addressed history, deterministic replay); see
[[Console One - Technical Notes]].
