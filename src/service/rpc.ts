import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import type { Api, RefRow, RelatedRow, SearchRequest, SearchResponse, StatusResponse } from "./api.js";

/**
 * JSON-RPC 2.0 over a Unix socket, one JSON message per line. A socket rather than a localhost
 * port: no port to collide, and the file's permissions (owner-only) decide who can connect.
 */

type Handler = (params: any) => Promise<unknown>;

export class AlreadyRunning extends Error {}

export interface RpcServer {
  close(): Promise<void>;
}

/** Listens on `path`. Throws AlreadyRunning if something answers there; removes a stale socket. */
export async function serve(path: string, handlers: Record<string, Handler>): Promise<RpcServer> {
  if (existsSync(path)) {
    const other = await connect(path, 500);
    if (other) {
      other.close();
      throw new AlreadyRunning(`cairnd is already running (${path})`);
    }
    unlinkSync(path);
  }
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setEncoding("utf8");
    const reply = (msg: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`);
    };
    const handle = async (line: string) => {
      let msg: { id?: unknown; method?: unknown; params?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        return reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
      const method = typeof msg.method === "string" ? msg.method : "";
      const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
      if (!handler) return reply({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32601, message: `unknown method: ${method}` } });
      try {
        reply({ jsonrpc: "2.0", id: msg.id ?? null, result: (await handler(msg.params)) ?? null });
      } catch (e) {
        reply({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
      }
    };
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.trim()) void handle(line);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          try {
            unlinkSync(path);
          } catch {
            // already gone
          }
          resolve();
        });
      }),
  };
}

export class RpcClient {
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const msg = JSON.parse(buffer.slice(0, i)) as { id: number; result?: unknown; error?: { message: string } };
        buffer = buffer.slice(i + 1);
        const w = this.waiting.get(msg.id);
        if (!w) continue;
        this.waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(msg.error.message));
        else w.resolve(msg.result);
      }
    });
    const fail = () => {
      for (const w of this.waiting.values()) w.reject(new Error("cairnd closed the connection"));
      this.waiting.clear();
    };
    socket.on("close", fail);
    socket.on("error", fail);
  }

  call<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close() {
    this.socket.end();
  }
}

/** Connects to cairnd, or resolves undefined if nothing is listening. */
export function connect(path: string, timeoutMs = 1000): Promise<RpcClient | undefined> {
  return new Promise((resolve) => {
    if (!existsSync(path)) return resolve(undefined);
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(undefined);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(new RpcClient(socket));
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

/** The Api, answered by cairnd. */
export class RemoteApi implements Api {
  constructor(private readonly client: RpcClient) {}
  search = (req: SearchRequest) => this.client.call<SearchResponse>("search", req);
  refs = (target: string) => this.client.call<RefRow[]>("refs", { target });
  related = (session: string) => this.client.call<RelatedRow[]>("related", { session });
  status = () => this.client.call<StatusResponse>("status");
  /** Asks cairnd to index now. Returns at once; `busy` means a run was already going. */
  trigger = () => this.client.call<{ scheduled: boolean; busy: boolean }>("trigger");
  close = () => this.client.close();
}
