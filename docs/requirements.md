---
title: Requirements
tags: [cairn, requirements]
status: draft
---

# Requirements

See [[background]] for why, and [[design]] for how.

## Users
- The author, across many concurrent agent sessions and projects.
- Developers using any coding agent with local session logs (Claude Code
  first, Codex next).
- Agents in those sessions, through MCP (Claude Code, Codex, Cursor, …).
- Other tools that import the library (Clance, later).

## Questions it must answer
1. "What did we decide about X?"
2. "Remember when we talked about X? Tell me more."
3. "Bring the context from that session into this one."

## Functional: v1
1. **Watch.** Follow every enabled source's session logs (Claude Code
   transcripts under `~/.claude/projects/` first), reading only what was
   appended since the last read. Sources are plug-ins, one per coding
   agent ([[packaging]]). On start, catch up on anything written while it was off. Nothing
   is missed or read twice.
2. **Append-only store.** Each new exchange becomes an immutable record
   with its project, session, time, text, files edited and commits made.
   Records are never edited. Identical content has the same hash and is
   stored once.
3. **Index on append.** As records arrive: a keyword index (exact names
   like `QUESTION_VERSION`), an embedding (meaning), and local labels.
4. **Enrichers are plug-ins.** Decision labels are the first enricher, and run locally: no Jev
   (decided 2026-10-16). **v1 label set (decided 2026-10-16):**
   - `decision`: something was settled in this exchange ("what did we decide…")
   - `unresolved`: a real question was raised and left open ("what's still open…")
   - `topic`: one of a fixed list (design, building, debugging, release, …), for
     filtering and grouping
   `preference` (how the author likes things done, across projects) comes later. Each
   enricher's output is its own derived record, keyed by
   `hash(exchange) + enricher version`, and can be dropped and rebuilt.
5. **`search(query, filters?)`.** Hybrid keyword + vector search,
   reranked, filterable by project, date and topic, grouped by session. Returns
   verbatim passages with source links.
6. **`open(source)`.** Return the stretch of a session around a passage,
   to bring into the current session.
7. **`brief(session)`.** An extractive summary: session name, project,
   dates, commits made, files touched, and its top passages by
   p(decision). All quoted, nothing generated.
8. **`ask(question)`.** Search, then have an LLM write an answer from the
   retrieved passages with citations. For interfaces without an agent (the
   CLI); in Claude Code, the agent in the session writes the answer from
   `search` results instead.
9. **Pointers.** Extract references from each exchange (file paths,
   commits, URLs, PR/issue refs, session ids) plus the files it edited and
   commits it made, as a link graph. Supports exact lookups ("everything
   about `src/match/jev.ts`"), related sessions, and following links during
   retrieval. Deterministic, no LLM.
10. **Rebuild.** Any index or enricher can be rebuilt from the store alone.
11. **Clients.** A CLI (search, open, brief, ask, refs, related) and a terminal
    dashboard (sources, status, search), and an MCP server (`search`,
    `open`, `brief`, `refs`, `related`) usable from any MCP-capable agent. Both are
    thin clients of a background service ([[packaging]]).
12. **Guided setup.** A first run that checks the machine, installs or
    detects Ollama, pulls the embedding model, picks sources and projects, starts the service, backfills, and
    registers the MCP server.

## Non-functional
- **Faithful:** results are verbatim and always carry their source
  (project, session, time).
- **No background LLM writing:** generated text only answers a question
  that was asked. Labels and embeddings are fine.
- **Conversation, not tool output:** enrichers and embeddings see
  conversation text; tool output is never sent to an external service.
- **Incremental and idempotent:** re-running ingest over the same
  transcripts changes nothing.
- **Cheap:** backfilling everything should cost around a dollar or less;
  ongoing cost around cents per day.
- **Local store:** the store and indexes live on this machine.
- **Fast enough to feel instant:** search under a second on the full
  history, reranking included. Hybrid search meets it (a query embeds in
  ~21 ms); a 5 s reranked search was judged too slow (2026-10-17).
- **TypeScript, Node 22+** (assumed: the author's stack and the other
  projects'; not yet discussed).

## Later (not v1)
- **LLM notes enricher.** A small model writes a typed note per exchange
  (topic, decision, open question), schema-checked, linked to the verbatim
  source. Switched on only if the retrieval eval shows "what did we decide"
  questions miss without it. Estimated ≈$1 to backfill, ≈$0.03/day.
- **More sources:** the Obsidian vault, other agent tools.
- **Clance integration.**
- **An LSM-backed store** behind the same store interface, as a learning
  side quest.

## Non-goals
- Summarising sessions in the background with an LLM.
- Replacing Claude Code's own session storage or `--resume`.
- Modifying transcripts.
- Multi-user or hosted use.

## Success metrics
- Retrieval: for a labelled set of questions, the right session appears in
  the top 5 results (recall@5). Target set after the first eval.
- The author reaches for it instead of scrolling through old sessions.
