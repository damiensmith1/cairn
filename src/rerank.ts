import { availableParallelism } from "node:os";
import { join } from "node:path";
import { cairnHome } from "./paths.js";

/**
 * Reorders search candidates by reading the question and each candidate together (a
 * cross-encoder). Slower than embeddings, so it only sees the top few candidates.
 */
export interface Reranker {
  /** Identifies the model and settings. */
  readonly id: string;
  /** A relevance score per document, higher is better, in the documents' order. */
  score(query: string, documents: string[]): Promise<number[]>;
  /** Frees the model; the next score() loads it again. */
  unload?(): Promise<void>;
  /** Whether the model is in memory. */
  readonly loaded?: boolean;
}

/** Characters of each candidate the reranker reads: its user message, then the reply. */
export const RERANK_CHARS = 1500;

/** How many of search's top candidates are reranked. 10 beat 20 in the eval (docs/experiments.md). */
export const RERANK_TOP = 10;

export interface OnnxRerankerOptions {
  model?: string;
  /** ONNX weights: "q8" (int8) matched full precision in the eval and runs 2.4× faster. */
  dtype?: "q8" | "fp32";
  /** Tokens per question + candidate pair; 512 beat 256 by ~0.02 MRR. */
  maxLength?: number;
  /** ONNX Runtime threads; 4 cut latency from 0.44 s to 0.32 s on an M2. */
  threads?: number;
  /** Where downloaded weights are cached. */
  cacheDir?: string;
}

type Classifier = (inputs: unknown) => Promise<{ logits: { data: ArrayLike<number> } }>;
type Tokenizer = (text: string[], options: Record<string, unknown>) => unknown;

/**
 * MiniLM-L6 cross-encoder via ONNX Runtime in Node (transformers.js), the reranker chosen in
 * docs/design.md. Weights download on first use (~23 MB int8) into ~/.cairn/models/transformers.
 */
export class OnnxReranker implements Reranker {
  readonly id: string;
  private readonly options: Required<OnnxRerankerOptions>;
  private loading: Promise<{ tokenizer: Tokenizer; model: Classifier & { dispose?: () => Promise<unknown> } }> | undefined;

  get loaded(): boolean {
    return this.loading !== undefined;
  }

  async unload(): Promise<void> {
    const loading = this.loading;
    this.loading = undefined;
    const model = await loading?.then((l) => l.model).catch(() => undefined);
    await model?.dispose?.();
  }

  constructor(options: OnnxRerankerOptions = {}) {
    this.options = {
      model: options.model ?? "Xenova/ms-marco-MiniLM-L-6-v2",
      dtype: options.dtype ?? "q8",
      maxLength: options.maxLength ?? 512,
      threads: options.threads ?? Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2))),
      cacheDir: options.cacheDir ?? join(cairnHome(), "models", "transformers"),
    };
    this.id = `onnx:${this.options.model}:${this.options.dtype}:${this.options.maxLength}`;
  }

  /** Loads the tokenizer and model once; transformers.js is imported only when needed. */
  private load() {
    this.loading ??= (async () => {
      const { AutoModelForSequenceClassification, AutoTokenizer, env } = await import("@huggingface/transformers");
      env.cacheDir = this.options.cacheDir;
      const tokenizer = (await AutoTokenizer.from_pretrained(this.options.model)) as unknown as Tokenizer;
      const model = (await AutoModelForSequenceClassification.from_pretrained(this.options.model, {
        dtype: this.options.dtype,
        device: "cpu",
        session_options: { intraOpNumThreads: this.options.threads, interOpNumThreads: 1 },
      } as never)) as unknown as Classifier;
      return { tokenizer, model };
    })();
    return this.loading;
  }

  async score(query: string, documents: string[]): Promise<number[]> {
    if (documents.length === 0) return [];
    const { tokenizer, model } = await this.load();
    const inputs = tokenizer(
      documents.map(() => query),
      { text_pair: documents, padding: true, truncation: true, max_length: this.options.maxLength },
    );
    const { logits } = await model(inputs);
    return Array.from(logits.data);
  }
}
