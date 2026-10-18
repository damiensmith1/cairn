import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeCodeSource, commitMessage, projectOf, typedText } from "../src/sources/claude-code.js";
import { initialState } from "../src/sources/source.js";
import { assistant, projectsDir, text, toolResult, toolUse, user } from "./helpers.js";

describe("typedText", () => {
  it("keeps typed text in both shapes and drops everything else", () => {
    expect(typedText(user("what did we decide?"))).toBe("what did we decide?");
    expect(typedText(user([text("look at this"), { type: "image", source: {} }]))).toBe("look at this");
    expect(typedText(toolResult())).toBe("");
    expect(typedText(user("<command-name>/fork</command-name>"))).toBe("");
    expect(typedText(user("<task-notification>done</task-notification>"))).toBe("");
    expect(typedText(user("hi", { isMeta: true }))).toBe("");
    expect(typedText(user("continued from earlier…", { isCompactSummary: true }))).toBe("");
    // Pasted content starts with a tag but is still typed by the user.
    expect(typedText(user('<pasted_content id="x">log</pasted_content> what is this?'))).toContain("what is this?");
  });
});

describe("commitMessage", () => {
  it("reads -m and heredoc messages", () => {
    expect(commitMessage('git commit -m "Release 0.2.0"')).toBe("Release 0.2.0");
    expect(commitMessage("git add -A && git commit -q -F - <<'EOF'\nAdd a judge eval\n\n- details\nEOF")).toBe("Add a judge eval");
    expect(commitMessage("git status")).toBeUndefined();
    // A python heredoc before the commit isn't its message.
    expect(commitMessage("python3 - <<'EOF'\np='CHANGELOG.md'\nEOF\ngit add -A && git commit -q -m \"Release 0.2.0\"")).toBe("Release 0.2.0");
    // A script that only mentions git commit isn't a commit.
    expect(commitMessage("python3 -c \"if 'git commit' in cmd: n += 1\"")).toBeUndefined();
    expect(commitMessage("cd repo && git -C ../x commit -m 'Fix it'")).toBe("Fix it");
    // A later command's heredoc or -m isn't the commit's message.
    expect(commitMessage("git commit -q -m \"Release 0.1.0\" && git tag -a v0.1.0 -m \"v0.1.0\"")).toBe("Release 0.1.0");
    expect(commitMessage("git commit -q -m \"Ship it\" && python3 - <<'EOF'\nimport json\nEOF")).toBe("Ship it");
    expect(commitMessage("git commit -m \"Fix a; b\"")).toBe("Fix a; b");
  });
});

describe("projectOf", () => {
  it("uses the repo folder, folding worktrees into their repo", () => {
    expect(projectOf("/Users/me/projects/llm-cassette")).toBe("llm-cassette");
    expect(projectOf("/Users/me/projects/glance/.claude/worktrees/fix-popup")).toBe("glance");
  });
});

describe("ClaudeCodeSource", () => {
  const session = [
    { type: "agent-name", agentName: "Cassette threshold" },
    user("should we keep 0.85?"),
    assistant([text("I'd keep 0.85 for now."), toolUse("Edit", { file_path: "/r/src/match/jev.ts" })]),
    toolResult(),
    assistant([text("Done."), toolUse("Bash", { command: 'git commit -m "Keep 0.85"' })]),
    user("yes, keep it"),
    assistant([text("Kept.")]),
  ];

  it("turns a transcript into exchanges with files, commits and the previous reply's tail", async () => {
    const { root, files } = projectsDir({ s1: session });
    const source = new ClaudeCodeSource(root);
    expect(await source.locations()).toEqual([files.s1]);
    const { exchanges, state } = await source.read(files.s1!, initialState(), true);
    expect(exchanges).toHaveLength(2);
    const [first, second] = exchanges;
    expect(first).toMatchObject({
      project: "llm-cassette",
      session: "s1",
      sessionName: "Cassette threshold",
      user: "should we keep 0.85?",
      assistant: "I'd keep 0.85 for now.\nDone.",
      files: ["/r/src/match/jev.ts"],
      commits: ["Keep 0.85"],
      prevTail: "",
    });
    expect(second!.prevTail).toBe("I'd keep 0.85 for now.\nDone.");
    expect(state.offset).toBeGreaterThan(0);
    expect(first!.hash).not.toBe(second!.hash);
  });

  it("holds back the exchange in progress until the next user message or idle", async () => {
    const { root, files } = projectsDir({ s1: session.slice(0, 3) });
    const source = new ClaudeCodeSource(root);
    const r1 = await source.read(files.s1!, initialState(), false);
    expect(r1.exchanges).toHaveLength(0);
    expect(r1.state.offset).toBeGreaterThan(0); // resumes at the open exchange's user line

    appendFileSync(files.s1!, [session[3], session[4], session[5]].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const r2 = await source.read(files.s1!, r1.state, false);
    expect(r2.exchanges.map((x) => x.user)).toEqual(["should we keep 0.85?"]);
    expect(r2.exchanges[0]!.assistant).toBe("I'd keep 0.85 for now.\nDone.");

    const r3 = await source.read(files.s1!, r2.state, true);
    expect(r3.exchanges.map((x) => x.user)).toEqual(["yes, keep it"]);
    expect(r3.exchanges[0]!.prevTail).toBe("I'd keep 0.85 for now.\nDone.");
  });

  it("ignores a half-written last line", async () => {
    const { root, files } = projectsDir({ s1: session });
    appendFileSync(files.s1!, '{"type":"user","message":{"content":"half');
    const { exchanges } = await new ClaudeCodeSource(root).read(files.s1!, initialState(), true);
    expect(exchanges).toHaveLength(2);
  });
});

describe("re-deriving parsed fields after a parser change", () => {
  it("fixes files and commits of stored exchanges once, leaving text alone", async () => {
    const { utimesSync } = await import("node:fs");
    const { ingest } = await import("../src/ingest.js");
    const { Store } = await import("../src/store.js");
    const { root, files } = projectsDir({
      s: [user("commit it"), assistant([text("Done."), toolUse("Bash", { command: 'git commit -m "Keep 0.85"' })])],
    });
    const old = Date.now() / 1000 - 3600;
    utimesSync(files.s!, old, old);
    const store = new Store(":memory:", 8);
    const source = new ClaudeCodeSource(root);
    expect((await ingest(store, [source])).reparsed).toBe(0); // fresh store: only records the version
    // Simulate a record parsed by an older, buggy parser.
    store.db.prepare(`UPDATE exchanges SET commits = '["p=CHANGELOG.md"]'`).run();
    store.setMeta("parser:claude-code", "1");
    const r = await ingest(store, [source]);
    expect(r.reparsed).toBe(1);
    const [x] = store.sessionExchanges("s");
    expect(x!.commits).toEqual(["Keep 0.85"]);
    expect(x!.user).toBe("commit it");
    expect(store.keyword('"keep"', 5).length).toBe(1); // keyword index follows
    expect((await ingest(store, [source])).reparsed).toBe(0); // once per version
  });
});
