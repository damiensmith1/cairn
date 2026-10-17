/**
 * Trains the label probes (decision, unresolved, topic) from labelled exchanges and writes the
 * model to ~/.cairn/models/labels.json. The labels come from the decision-labels spike
 * (docs/experiments.md): windows.jsonl + labels_*.jsonl + tu_*.jsonl. Features are the vectors
 * cairn stores for each exchange, so the probes see exactly what they'll label in production.
 *
 *   npm run train-labels [-- <spike dir>]
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OllamaEmbedder } from "../src/embed.js";
import { auc, predictBinary, predictMulticlass, trainBinary, trainMulticlass } from "../src/labels.js";
import type { LabelModel } from "../src/labels.js";
import { cairnHome, dbPath } from "../src/paths.js";
import { Store } from "../src/store.js";

const spike = process.argv[2] ?? join(homedir(), ".cairn", "spikes", "decisions");
const jsonl = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// Labelled windows → the stored exchanges they were cut from (same session, same user text).
const windows = jsonl(join(spike, "windows.jsonl")) as { id: string; session: string; text: string }[];
const decision = new Map<string, string>();
const tu = new Map<string, { topic: string; unresolved: string }>();
for (const b of [0, 1, 2]) {
  for (const r of jsonl(join(spike, `labels_${b}.jsonl`))) decision.set(r.id, r.label);
  for (const r of jsonl(join(spike, `tu_${b}.jsonl`))) tu.set(r.id, r);
}

const embedder = new OllamaEmbedder();
const store = new Store(dbPath(), embedder.dims);
const userOf = (text: string) => text.split("[user] ")[1]?.split("\n[assistant reply, start]")[0]?.trim() ?? "";
const findSeq = store.db.prepare("SELECT seq FROM exchanges WHERE session = ? AND substr(user, 1, ?) = ? ORDER BY seq LIMIT 1");

interface Item {
  id: string;
  session: string;
  x: Float32Array;
}
const items: Item[] = [];
for (const w of windows) {
  const prefix = userOf(w.text);
  const row = findSeq.get(w.session, prefix.length, prefix) as { seq: number } | undefined;
  const x = row && store.exchangeVector(row.seq, embedder.id);
  if (x) items.push({ id: w.id, session: w.session, x });
}
console.log(`matched ${items.length} of ${windows.length} labelled exchanges to stored vectors`);
if (items.length < 50) throw new Error("too few labelled exchanges matched; is the store embedded?");

/** Folds that never split a session (scikit-learn's GroupKFold: biggest sessions first, into the smallest fold). */
function groupFolds(sessions: string[], k = 5): number[] {
  const size = new Map<string, number>();
  for (const s of sessions) size.set(s, (size.get(s) ?? 0) + 1);
  const foldOf = new Map<string, number>();
  const load = new Array(k).fill(0);
  for (const [s, n] of [...size].sort((a, b) => b[1] - a[1])) {
    const f = load.indexOf(Math.min(...load));
    foldOf.set(s, f);
    load[f] += n;
  }
  return sessions.map((s) => foldOf.get(s)!);
}

function cvBinary(subset: Item[], y: boolean[]): number {
  const folds = groupFolds(subset.map((i) => i.session));
  const scores = new Array<number>(subset.length);
  for (let f = 0; f < 5; f++) {
    const train = subset.map((_, i) => i).filter((i) => folds[i] !== f);
    const probe = trainBinary(train.map((i) => subset[i]!.x), train.map((i) => y[i]!));
    subset.forEach((it, i) => {
      if (folds[i] === f) scores[i] = predictBinary(probe, it.x);
    });
  }
  return auc(scores, y);
}

function cvMulticlass(subset: Item[], y: string[]): number {
  const folds = groupFolds(subset.map((i) => i.session));
  let right = 0;
  for (let f = 0; f < 5; f++) {
    const train = subset.map((_, i) => i).filter((i) => folds[i] !== f);
    const probe = trainMulticlass(train.map((i) => subset[i]!.x), train.map((i) => y[i]!));
    subset.forEach((it, i) => {
      if (folds[i] !== f) return;
      const p = predictMulticlass(probe, it.x);
      if (probe.classes[p.indexOf(Math.max(...p))] === y[i]) right++;
    });
  }
  return right / subset.length;
}

const dItems = items.filter((i) => decision.get(i.id) === "yes" || decision.get(i.id) === "no");
const dY = dItems.map((i) => decision.get(i.id) === "yes");
const uItems = items.filter((i) => ["yes", "no"].includes(tu.get(i.id)?.unresolved ?? ""));
const uY = uItems.map((i) => tu.get(i.id)!.unresolved === "yes");
const tItems = items.filter((i) => tu.get(i.id)?.topic);
const tY = tItems.map((i) => tu.get(i.id)!.topic);

const metrics = {
  decision_auc: cvBinary(dItems, dY),
  unresolved_auc: cvBinary(uItems, uY),
  topic_accuracy: cvMulticlass(tItems, tY),
};
console.log("cross-validated by session (spike, on window embeddings: decision 0.68, unresolved 0.64, topic 0.52):");
for (const [k, v] of Object.entries(metrics)) console.log(`  ${k.padEnd(16)} ${v.toFixed(3)}`);

const weights = {
  decision: trainBinary(dItems.map((i) => i.x), dY),
  unresolved: trainBinary(uItems.map((i) => i.x), uY),
  topic: trainMulticlass(tItems.map((i) => i.x), tY),
};
const version = `probe-v1-${createHash("sha256").update(JSON.stringify(weights)).digest("hex").slice(0, 8)}`;
const model: LabelModel = { version, embedder: embedder.id, dims: embedder.dims, ...weights, metrics, trainedAt: new Date().toISOString() };

const dir = join(cairnHome(), "models");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(dir, "labels.json");
writeFileSync(file, JSON.stringify(model), { mode: 0o600 });
chmodSync(file, 0o600);
store.close();
console.log(`wrote ${file} (${version}); run \`cairn index\` to label stored exchanges`);
