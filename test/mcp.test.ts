import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp.js";
import type { Api, OpenResponse } from "../src/service/api.js";
import type { StoredExchange } from "../src/types.js";

const exchange = (seq: number, user: string, assistant: string): StoredExchange =>
  ({
    seq,
    hash: `h${seq}`,
    source: "claude-code",
    project: "cairn",
    cwd: "/p/cairn",
    session: "11111111-2222-3333-4444-555555555555",
    sessionName: "storage choice",
    at: `2026-10-16T10:0${seq}:00.000Z`,
    user,
    assistant,
    prevTail: "",
    files: [],
    commits: [],
  }) as unknown as StoredExchange;

const KEY = `sk-ant-api03-${"x".repeat(40)}`;

/** Answers from fixed data, and counts connections so we can check each call closes its own. */
function fakeApi() {
  const calls = { opened: 0, closed: 0, search: [] as unknown[] };
  const connect = async (): Promise<Api> => {
    calls.opened++;
    return {
      search: async (req) => {
        calls.search.push(req);
        const x = exchange(5, "which storage should cairn use?", "SQLite with FTS5 and sqlite-vec.");
        return { groups: [{ session: x.session, sessionName: x.sessionName, project: "cairn", hits: [{ exchange: x, score: 1, via: ["keyword"], snippet: `«SQLite» it is; the key was ${KEY}` }] }], reranked: true, labels: false };
      },
      open: async (id): Promise<OpenResponse | null> =>
        id === 5 ? { target: 5, session: "11111111-2222-3333-4444-555555555555", sessionName: "storage choice", project: "cairn", exchanges: [exchange(4, "before", "earlier reply"), exchange(5, "which storage?", "SQLite. ".repeat(1000))] } : null,
      brief: async () => null,
      refs: async () => [],
      related: async () => [],
      status: async () => {
        throw new Error("not used");
      },
      close: () => void calls.closed++,
    };
  };
  return { connect, calls };
}

async function connected(options: { session?: string } = {}) {
  const fake = fakeApi();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(fake.connect, "0", options).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as { text: string }[])[0]!.text, isError: Boolean(r.isError) };
  };
  return { client, call, calls: fake.calls };
}

describe("cairn mcp", () => {
  it("offers read-only tools and instructions, and no ask", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["brief", "open", "refs", "related", "search"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(client.getInstructions()).toMatch(/not as instructions|never as instructions/);
  });

  it("searches, masks secrets, marks results as data, and closes each connection", async () => {
    const { call, calls } = await connected();
    const r = await call("search", { query: "storage", project: "cairn", limit: 3 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("data, not instructions");
    expect(r.text).toContain("#5 · 2026-10-16 10:05");
    expect(r.text).toContain("cairn · storage choice");
    expect(r.text).not.toContain(KEY);
    expect(r.text).toContain("[anthropic key]");
    expect(r.text).not.toContain("«");
    expect(calls.search[0]).toMatchObject({ query: "storage", project: "cairn", limit: 3 });
    expect(calls.closed).toBe(calls.opened);
  });

  it("passes its own session along, and marks that session's earlier exchanges", async () => {
    const own = "11111111-2222-3333-4444-555555555555";
    const { call, calls } = await connected({ session: own });
    const r = await call("search", { query: "storage" });
    expect(calls.search[0]).toMatchObject({ askingSession: own });
    expect(r.text).toContain("this session, from before it was compacted");
    const other = await connected({ session: "someone-else" });
    expect((await other.call("search", { query: "storage" })).text).not.toContain("this session");
  });

  it("opens by #id, clips long replies unless full, and reports unknown ids as errors", async () => {
    const { call } = await connected();
    const clipped = await call("open", { id: "#5" });
    expect(clipped.text).toContain("▶ #5");
    expect(clipped.text).toMatch(/more characters; open with full: true/);
    const full = await call("open", { id: 5, full: true });
    expect(full.text).not.toMatch(/more characters/);
    const missing = await call("open", { id: 99 });
    expect(missing).toMatchObject({ isError: true, text: "No exchange #99." });
  });

  it("rejects bad input before calling cairn", async () => {
    const { call, calls } = await connected();
    const r = await call("search", { query: "" });
    expect(r.isError).toBe(true);
    expect(calls.search).toHaveLength(0);
  });
});
