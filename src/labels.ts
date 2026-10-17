import { existsSync, readFileSync } from "node:fs";
import type { Store } from "./store.js";

/**
 * Label probes: tiny linear models on top of the exchange's embedding (the mean of its chunk
 * vectors). Trained offline on labelled exchanges; see docs/experiments.md for why a probe beat
 * Laya as the labeller.
 */
export interface BinaryProbe {
  type: "binary";
  coef: number[];
  intercept: number;
}

export interface MulticlassProbe {
  type: "multiclass";
  classes: string[];
  coef: number[][];
  intercept: number[];
}

export interface LabelModel {
  /** Changes whenever the weights do; part of every stored label's key. */
  version: string;
  /** The embedder whose vectors the probes read. Labels are only computed from that embedder. */
  embedder: string;
  dims: number;
  decision: BinaryProbe;
  unresolved: BinaryProbe;
  topic: MulticlassProbe;
  /** Cross-validated quality at training time, for `cairn status`. */
  metrics?: Record<string, number>;
  trainedAt?: string;
}

export interface Labels {
  pDecision: number;
  pUnresolved: number;
  topic: string;
  topicProbs: Record<string, number>;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
function softmax(z: number[]): number[] {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

export const predictBinary = (p: BinaryProbe, x: ArrayLike<number>) => sigmoid(dot(p.coef, x) + p.intercept);

export function predictMulticlass(p: MulticlassProbe, x: ArrayLike<number>): number[] {
  return softmax(p.coef.map((w, k) => dot(w, x) + p.intercept[k]!));
}

export function predict(model: LabelModel, x: ArrayLike<number>): Labels {
  const probs = predictMulticlass(model.topic, x);
  const best = probs.indexOf(Math.max(...probs));
  return {
    pDecision: predictBinary(model.decision, x),
    pUnresolved: predictBinary(model.unresolved, x),
    topic: model.topic.classes[best]!,
    topicProbs: Object.fromEntries(model.topic.classes.map((c, k) => [c, probs[k]!])),
  };
}

export function loadLabelModel(file: string): LabelModel | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as LabelModel) : undefined;
}

/** Labels every embedded exchange that has none for this model version. */
export function labelPending(store: Store, model: LabelModel, embedderId: string): number {
  if (model.embedder !== embedderId) {
    throw new Error(`Label model reads ${model.embedder} vectors but the store embeds with ${embedderId}; retrain it.`);
  }
  let n = 0;
  for (;;) {
    const seqs = store.unlabelled(model.version, embedderId, 256);
    if (seqs.length === 0) return n;
    store.addLabels(
      model.version,
      seqs.map((seq) => ({ seq, labels: predict(model, store.exchangeVector(seq, embedderId)!) })),
    );
    n += seqs.length;
  }
}

// ---- training ---------------------------------------------------------------------------

export interface TrainOptions {
  /** Inverse L2 strength, as in scikit-learn's LogisticRegression (C = 1 by default). */
  c?: number;
  iterations?: number;
  learningRate?: number;
}

/** Adam on a full batch: enough for a few hundred examples and ~1k features. */
function adam(dim: number, grad: (w: Float64Array) => Float64Array, { iterations = 600, learningRate = 0.05 }: TrainOptions) {
  const w = new Float64Array(dim);
  const m = new Float64Array(dim);
  const v = new Float64Array(dim);
  const [b1, b2, eps] = [0.9, 0.999, 1e-8];
  for (let t = 1; t <= iterations; t++) {
    const g = grad(w);
    for (let i = 0; i < dim; i++) {
      m[i] = b1 * m[i]! + (1 - b1) * g[i]!;
      v[i] = b2 * v[i]! + (1 - b2) * g[i]! * g[i]!;
      w[i]! -= (learningRate * (m[i]! / (1 - b1 ** t))) / (Math.sqrt(v[i]! / (1 - b2 ** t)) + eps);
    }
  }
  return w;
}

/** Class weights that make each class count equally, as scikit-learn's class_weight="balanced". */
function balanced<T>(y: T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const c of y) counts.set(c, (counts.get(c) ?? 0) + 1);
  return new Map([...counts].map(([c, n]) => [c, y.length / (counts.size * n)]));
}

/** L2-regularised logistic regression with balanced class weights. */
export function trainBinary(X: Float32Array[], y: boolean[], options: TrainOptions = {}): BinaryProbe {
  const d = X[0]!.length;
  const lambda = 1 / (options.c ?? 1);
  const cw = balanced(y);
  const w = adam(
    d + 1,
    (w) => {
      const g = new Float64Array(d + 1);
      for (let i = 0; i < X.length; i++) {
        const x = X[i]!;
        const err = (sigmoid(dot(w.subarray(0, d), x) + w[d]!) - (y[i] ? 1 : 0)) * cw.get(y[i]!)!;
        for (let j = 0; j < d; j++) g[j]! += err * x[j]!;
        g[d]! += err;
      }
      for (let j = 0; j < d; j++) g[j]! += lambda * w[j]!; // the intercept isn't regularised
      return g;
    },
    options,
  );
  return { type: "binary", coef: Array.from(w.subarray(0, d)), intercept: w[d]! };
}

/** L2-regularised softmax regression with balanced class weights. */
export function trainMulticlass(X: Float32Array[], y: string[], options: TrainOptions = {}): MulticlassProbe {
  const d = X[0]!.length;
  const classes = [...new Set(y)].sort();
  const K = classes.length;
  const lambda = 1 / (options.c ?? 1);
  const cw = balanced(y);
  const idx = y.map((c) => classes.indexOf(c));
  const W = adam(
    K * (d + 1),
    (W) => {
      const g = new Float64Array(K * (d + 1));
      for (let i = 0; i < X.length; i++) {
        const x = X[i]!;
        const z = classes.map((_, k) => dot(W.subarray(k * (d + 1), k * (d + 1) + d), x) + W[k * (d + 1) + d]!);
        const p = softmax(z);
        const weight = cw.get(y[i]!)!;
        for (let k = 0; k < K; k++) {
          const err = (p[k]! - (k === idx[i] ? 1 : 0)) * weight;
          const base = k * (d + 1);
          for (let j = 0; j < d; j++) g[base + j]! += err * x[j]!;
          g[base + d]! += err;
        }
      }
      for (let k = 0; k < K; k++) for (let j = 0; j < d; j++) g[k * (d + 1) + j]! += lambda * W[k * (d + 1) + j]!;
      return g;
    },
    options,
  );
  return {
    type: "multiclass",
    classes,
    coef: classes.map((_, k) => Array.from(W.subarray(k * (d + 1), k * (d + 1) + d))),
    intercept: classes.map((_, k) => W[k * (d + 1) + d]!),
  };
}

/** Area under the ROC curve: the chance a random positive scores above a random negative. */
export function auc(scores: number[], y: boolean[]): number {
  const pos = scores.filter((_, i) => y[i]);
  const neg = scores.filter((_, i) => !y[i]);
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}
