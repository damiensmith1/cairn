import type Anthropic from "@anthropic-ai/sdk";
import { utimesSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ask, ASK_MODEL, toPassage } from "../src/ask.js";
import { embedPending, ingest } from "../src/ingest.js";
import { maskSecrets } from "../src/secrets.js";
import { Core } from "../src/service/core.js";
import { ClaudeCodeSource } from "../src/sources/claude-code.js";
import { Store } from "../src/store.js";
import { assistant, FakeEmbedder, projectsDir, text, toolUse, user } from "./helpers.js";

describe("maskSecrets", () => {
  it("masks keys and tokens and leaves ordinary text alone", () => {
    const masked = maskSecrets(
      [
        "key sk-ant-api03-abcdefghijklmnopqrstuvwx",
        "openai sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123",
        "gh ghp_abcdefghijklmnopqrstuvwxyz0123",
        "aws AKIAABCDEFGHIJKLMNOP",
        "Authorization: Bearer abcdef0123456789abcdef",
        "TYPESAFE_API_KEY=ts_live_123456789",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
        "we kept the threshold at 0.85 for the cassette",
      ].join("\n"),
    );
    expect(masked).not.toMatch(/abcdefghijklmnopqrstuvwx|ABCDEFGHIJKLMNOPQRSTUVWXYZ|AKIAABCD|abcdef0123456789|ts_live_|MIIEow/);
    expect(masked).toContain("[anthropic key]");
    expect(masked).toContain("Bearer [token]");
    expect(masked).toContain("TYPESAFE_API_KEY=[redacted]");
    expect(masked).toContain("we kept the threshold at 0.85 for the cassette");
  });
});

async function core() {
  const { root, files } = projectsDir({
    s: [
      { type: "agent-name", agentName: "Cassette threshold" },
      user("should we keep 0.85?"),
      assistant([text("Keep 0.85."), toolUse("Edit", { file_path: "/Users/me/projects/llm-cassette/src/config.ts" })]),
      user("yes, commit it"),
      assistant([text("Done."), toolUse("Bash", { command: 'git commit -m "Keep the 0.85 threshold"' })]),
      user("and the key is sk-ant-api03-abcdefghijklmnopqrstuvwx, store it?"),
      assistant([text("I won't store keys in the repo.")]),
    ],
  });
  const old = Date.now() / 1000 - 3600;
  utimesSync(files.s!, old, old);
  const embedder = new FakeEmbedder();
  const c = new Core(new Store(":memory:", embedder.dims), embedder, [new ClaudeCodeSource(root)], undefined, undefined);
  await ingest(c.store, c.sources);
  await embedPending(c.store, embedder);
  return c;
}

describe("open and brief", () => {
  it("opens an exchange with its neighbours, in session order", async () => {
    const c = await core();
    const [first, second, third] = c.store.sessionExchanges("s");
    const res = (await c.open(second!.seq, 1))!;
    expect(res.exchanges.map((x) => x.seq)).toEqual([first!.seq, second!.seq, third!.seq]);
    expect(res.sessionName).toBe("Cassette threshold");
    expect(await c.open(99999)).toBeNull();
  });

  it("briefs a session from quoted facts, found by id, prefix or exchange", async () => {
    const c = await core();
    const b = (await c.brief("s"))!;
    expect(b).toMatchObject({ sessionName: "Cassette threshold", exchanges: 3, commits: ["Keep the 0.85 threshold"] });
    expect(b.files).toEqual([{ path: "src/config.ts", edits: 1 }]);
    expect(b.key.map((k) => k.why)).toEqual([["first"], ["commit"], ["last"]]);
    const [x] = c.store.sessionExchanges("s");
    expect((await c.brief(`#${x!.seq}`))?.session).toBe("s");
    expect(await c.brief("nope")).toBeNull();
  });
});

describe("ask", () => {
  it("retrieves passages, masks secrets, and streams Haiku's answer", async () => {
    const c = await core();
    let request: Record<string, any> | undefined;
    const fake = {
      messages: {
        stream: (req: Record<string, any>) => {
          request = req;
          const events = [
            { type: "content_block_delta", delta: { type: "text_delta", text: "You kept 0.85 " } },
            { type: "content_block_delta", delta: { type: "text_delta", text: "[#1]." } },
          ];
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
            finalMessage: async () => ({ stop_reason: "end_turn" }),
          };
        },
      },
    } as unknown as Anthropic;
    let out = "";
    const res = await ask(c, "what threshold did we keep?", (t) => (out += t), fake);
    expect(out).toBe("You kept 0.85 [#1].");
    expect(res.stopReason).toBe("end_turn");
    expect(request!.model).toBe(ASK_MODEL);
    const prompt = request!.messages[0].content as string;
    expect(prompt).toContain("<passages>");
    expect(prompt).toMatch(/\[#\d+\] Cassette threshold/);
    expect(prompt).not.toContain("sk-ant-api03");
    expect(res.passages.length).toBeGreaterThan(0);
  });

  it("labels a passage with its session, project and date", () => {
    const x = { seq: 7, session: "abcdef1234", project: "cairn", at: "2026-10-16T08:00:00Z", user: "q", assistant: "a", prevTail: "" };
    expect(toPassage(x as never, null).label).toBe("abcdef12 · cairn · 2026-10-16");
  });
});
