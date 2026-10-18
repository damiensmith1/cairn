/** Turns text into vectors. Documents and queries may be embedded differently. */
export interface Embedder {
  /** Identifies the model; stored with every vector so a model change is detected. */
  readonly id: string;
  readonly dims: number;
  embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]>;
  /** What's missing for this embedder to work, or undefined if it's ready. */
  problem?(): Promise<string | undefined>;
}

/**
 * Qwen3-Embedding is instruction-aware: queries get a task instruction, stored chunks don't.
 * See docs/experiments.md.
 */
export const QUERY_INSTRUCTION =
  "Instruct: Given a question about past conversations with a coding agent, retrieve the passages that answer it\nQuery: ";

/** The embedding model cairn pulls and uses (docs/experiments.md). */
export const DEFAULT_EMBED_MODEL = "qwen3-embedding:0.6b";

export interface OllamaOptions {
  model?: string;
  url?: string;
  dims?: number;
  /** Context window per input; chunks are ~1k tokens. */
  numCtx?: number;
  /** Give up on a request after this long, so a sleeping laptop or a stuck server can't hang a backfill. */
  timeoutMs?: number;
}

/** Embeddings from a local Ollama server. */
export class OllamaEmbedder implements Embedder {
  readonly id: string;
  readonly dims: number;
  private readonly model: string;
  private readonly url: string;
  private readonly numCtx: number;
  private readonly timeoutMs: number;

  constructor(options: OllamaOptions = {}) {
    this.model = options.model ?? DEFAULT_EMBED_MODEL;
    this.url = options.url ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
    this.dims = options.dims ?? 1024;
    this.numCtx = options.numCtx ?? 2048;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.id = `ollama:${this.model}`;
  }

  async embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const input = kind === "query" ? texts.map((t) => QUERY_INSTRUCTION + t) : texts;
    const res = await fetch(`${this.url}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input, options: { num_ctx: this.numCtx } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { embeddings } = (await res.json()) as { embeddings: number[][] };
    return embeddings.map((v) => {
      if (v.length !== this.dims) throw new Error(`${this.model} returned ${v.length} dims, expected ${this.dims}`);
      return Float32Array.from(v);
    });
  }

  /** What's missing for this embedder to work, or undefined if it's ready. */
  async problem(): Promise<string | undefined> {
    try {
      const res = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      const { models } = (await res.json()) as { models: { name: string }[] };
      if (!models.some((m) => m.name === this.model)) return `Ollama is running but ${this.model} isn't pulled: ollama pull ${this.model}`;
    } catch {
      return `Ollama isn't reachable at ${this.url}. Start it, or install it: brew install ollama`;
    }
    return undefined;
  }
}
