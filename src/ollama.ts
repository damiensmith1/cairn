import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

export const ollamaUrl = () => process.env.OLLAMA_HOST ?? "http://localhost:11434";

/** How Ollama is installed: the macOS app, a Homebrew formula, some other CLI install, or not at all. */
export function ollamaInstall(): "app" | "brew" | "cli" | undefined {
  if (existsSync("/Applications/Ollama.app")) return "app";
  const which = spawnSync("which", ["ollama"], { encoding: "utf8" });
  if (which.status !== 0) return undefined;
  const bin = realpathSync(which.stdout.trim());
  return /\/(Cellar|homebrew)\//.test(bin) ? "brew" : "cli";
}

export const hasBrew = () => spawnSync("which", ["brew"], { stdio: "ignore" }).status === 0;

export async function ollamaRunning(url = ollamaUrl()): Promise<boolean> {
  try {
    return (await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

export async function hasModel(model: string, url = ollamaUrl()): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const { models } = (await res.json()) as { models: { name: string }[] };
    return models.some((m) => m.name === model);
  } catch {
    return false;
  }
}

/** Runs a command with its output shown, resolving with its exit code. */
const run = (cmd: string, args: string[]) =>
  new Promise<number>((resolve) => spawn(cmd, args, { stdio: "inherit" }).on("close", (code) => resolve(code ?? 1)));

/** `brew install ollama`, output shown. */
export const installOllama = () => run("brew", ["install", "ollama"]);

/** Starts Ollama the way it's installed, then waits until it answers. */
export async function startOllama(install: "app" | "brew" | "cli", timeoutMs = 30_000): Promise<boolean> {
  if (install === "app") spawnSync("open", ["-a", "Ollama"]);
  else if (install === "brew") spawnSync("brew", ["services", "start", "ollama"], { stdio: "ignore" });
  else spawn("ollama", ["serve"], { detached: true, stdio: "ignore" }).unref();
  for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
    if (await ollamaRunning()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

/**
 * Pulls a model, reporting progress. Ollama keeps partly downloaded layers, so after a failure
 * (network drop, laptop asleep) a retry resumes where it stopped; this retries a few times itself.
 */
export async function pullModel(model: string, onProgress: (p: PullProgress) => void, url = ollamaUrl(), attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${url}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true }),
      });
      if (!res.ok || !res.body) throw new Error(`Ollama returned ${res.status}`);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as PullProgress & { error?: string };
          if (msg.error) throw new Error(msg.error);
          onProgress(msg);
          if (msg.status === "success") return;
        }
      }
      throw new Error("the download ended early");
    } catch (e) {
      if (attempt >= attempts) throw e;
      onProgress({ status: `retrying (${e instanceof Error ? e.message : String(e)})` });
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
