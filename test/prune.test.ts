import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "..", "scripts", "prune.mjs");
const other = process.platform === "darwin" ? "linux" : "darwin";

/** A fake installed cairn: `<root>/node_modules/@damiensmith1/cairn`, with its own node_modules. */
function fakeInstall(root: string) {
  const pkg = join(root, "node_modules", "@damiensmith1", "cairn");
  const file = (path: string, content = "x") => {
    mkdirSync(dirname(join(pkg, path)), { recursive: true });
    writeFileSync(join(pkg, path), content);
  };
  file("package.json", JSON.stringify({ name: "@damiensmith1/cairn", dependencies: { "@huggingface/transformers": "1", "onnxruntime-node": "1", "better-sqlite3": "1", sharp: "1", kept: "1" } }));
  file("scripts/prune.mjs", readFileSync(script, "utf8"));
  file(`node_modules/onnxruntime-node/package.json`, "{}");
  file(`node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime.node`);
  file(`node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/other-arch/onnxruntime.node`);
  file(`node_modules/onnxruntime-node/bin/napi-v6/${other}/x64/onnxruntime.node`);
  file("node_modules/onnxruntime-web/package.json", "{}");
  file("node_modules/better-sqlite3/package.json", "{}");
  file(`node_modules/better-sqlite3/prebuilds/${process.platform}-${process.arch}.node`);
  file(`node_modules/better-sqlite3/prebuilds/${other}-x64.node`);
  file("node_modules/better-sqlite3/deps/sqlite3.c");
  file("node_modules/sharp/package.json", JSON.stringify({ name: "sharp", main: "./dist/index.cjs", exports: { ".": { import: { default: "./dist/index.mjs" }, require: { default: "./dist/index.cjs" } } } }));
  file("node_modules/sharp/dist/index.mjs", "real sharp");
  file("node_modules/sharp/dist/index.cjs", "real sharp");
  file("node_modules/@img/sharp-libvips-whatever/lib.dylib");
  file("node_modules/@huggingface/transformers/package.json", "{}");
  file("node_modules/@huggingface/transformers/dist/transformers.node.mjs");
  file("node_modules/@huggingface/transformers/dist/transformers.web.js");
  file("node_modules/kept/package.json", JSON.stringify({ name: "kept", dependencies: { "kept-dep": "1" } }));
  file("node_modules/kept/index.js");
  file("node_modules/kept/index.d.ts");
  file("node_modules/kept/index.js.map");
  file("node_modules/kept/README.md");
  file("node_modules/kept-dep/package.json", "{}");
  file("node_modules/protobufjs/package.json", "{}"); // nothing depends on it
  file("node_modules/@types/node/index.d.ts");
  file("node_modules/express/package.json", "{}");
  return { pkg, has: (path: string) => existsSync(join(pkg, path)), read: (path: string) => readFileSync(join(pkg, path), "utf8") };
}

describe("scripts/prune.mjs", () => {
  it("removes what cairn never loads and keeps what it does", () => {
    const { pkg, has, read } = fakeInstall(mkdtempSync(join(tmpdir(), "cairn-prune-")));
    const r = spawnSync(process.execPath, [join(pkg, "scripts", "prune.mjs")], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/removed unused parts of its dependencies/);

    // Kept: this platform's binaries, the Node bundle, reachable packages and their code.
    expect(has(`node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime.node`)).toBe(true);
    expect(has(`node_modules/better-sqlite3/prebuilds/${process.platform}-${process.arch}.node`)).toBe(true);
    expect(has("node_modules/@huggingface/transformers/dist/transformers.node.mjs")).toBe(true);
    expect(has("node_modules/kept/index.js")).toBe(true);
    expect(has("node_modules/kept-dep/package.json")).toBe(true);

    // Removed: other platforms, sources, the browser runtime, orphans, the HTTP stack, dev files.
    expect(has(`node_modules/onnxruntime-node/bin/napi-v6/${other}`)).toBe(false);
    expect(has(`node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/other-arch`)).toBe(false);
    expect(has(`node_modules/better-sqlite3/prebuilds/${other}-x64.node`)).toBe(false);
    expect(has("node_modules/better-sqlite3/deps")).toBe(false);
    expect(has("node_modules/onnxruntime-web")).toBe(false);
    expect(has("node_modules/@huggingface/transformers/dist/transformers.web.js")).toBe(false);
    expect(has("node_modules/@img/sharp-libvips-whatever")).toBe(false);
    expect(has("node_modules/protobufjs")).toBe(false);
    expect(has("node_modules/express")).toBe(false);
    expect(has("node_modules/@types")).toBe(false);
    expect(has("node_modules/kept/index.d.ts") || has("node_modules/kept/index.js.map") || has("node_modules/kept/README.md")).toBe(false);

    // sharp is a stub at its entry points: importable, throws if ever called.
    expect(read("node_modules/sharp/dist/index.mjs")).toMatch(/^export default \(\) => \{ throw new Error/);
    expect(read("node_modules/sharp/dist/index.cjs")).toMatch(/^module\.exports = \(\) => \{ throw new Error/);

    // Running it again changes nothing.
    expect(spawnSync(process.execPath, [join(pkg, "scripts", "prune.mjs")]).status).toBe(0);
    expect(has("node_modules/kept/index.js")).toBe(true);
  });

  it("does nothing outside an installed package (a source checkout)", () => {
    const repo = mkdtempSync(join(tmpdir(), "cairn-checkout-"));
    mkdirSync(join(repo, "scripts"));
    mkdirSync(join(repo, "node_modules", "onnxruntime-web"), { recursive: true });
    copyFileSync(script, join(repo, "scripts", "prune.mjs"));
    const r = spawnSync(process.execPath, [join(repo, "scripts", "prune.mjs")], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(join(repo, "node_modules", "onnxruntime-web"))).toBe(true);
  });
});
