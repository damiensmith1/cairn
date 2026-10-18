#!/usr/bin/env node
/**
 * Deletes the parts of cairn's dependencies it never loads, other platforms' native binaries above
 * all, shrinking an install several times over. Each deletion was checked against the reranker
 * giving identical scores and the CLI and MCP server working (docs/packaging.md).
 *
 * `cairn init` runs it, after npm has finished. Not a postinstall script: npm runs dependencies'
 * own install scripts after the package's, so deleting a package from there fails the install.
 * Only cairn's own nested node_modules is touched, never a project's shared one, and a step that
 * fails leaves its files in place: cairn just stays bigger.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const modules = join(pkgDir, "node_modules");
const { platform, arch } = process;

/** Bytes under a path. */
function size(path) {
  try {
    const s = statSync(path);
    if (!s.isDirectory()) return s.size;
    return readdirSync(path).reduce((n, f) => n + size(join(path, f)), 0);
  } catch {
    return 0;
  }
}

const remove = (path) => rmSync(path, { recursive: true, force: true });
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
const inModules = (...parts) => join(modules, ...parts);
const children = (path) => (existsSync(path) ? readdirSync(path) : []);

/** Native binaries for other operating systems and CPUs. */
function otherPlatforms() {
  // onnxruntime-node: bin/napi-v*/<os>/<arch>/
  for (const napi of children(inModules("onnxruntime-node", "bin"))) {
    const base = inModules("onnxruntime-node", "bin", napi);
    for (const os of children(base)) {
      if (os !== platform) remove(join(base, os));
      else for (const a of children(join(base, os))) if (a !== arch) remove(join(base, os, a));
    }
  }
  // better-sqlite3: prebuilds/<os>[musl]-<arch>.node, plus the C sources only needed to compile.
  const prebuilds = inModules("better-sqlite3", "prebuilds");
  for (const f of children(prebuilds)) if (f !== `${platform}-${arch}.node` && f !== `${platform}musl-${arch}.node`) remove(join(prebuilds, f));
  remove(inModules("better-sqlite3", "deps"));
  remove(inModules("better-sqlite3", "src"));
}

/** transformers.js extras cairn never uses in Node. */
function transformersExtras() {
  // Its Node build bundles the runtime it needs; the separate browser runtime is never loaded.
  remove(inModules("onnxruntime-web"));
  // Only the Node bundles are loaded (its package exports: node.import / node.require).
  const dist = inModules("@huggingface", "transformers", "dist");
  for (const f of children(dist)) if (!/^transformers\.node\.(mjs|cjs)$/.test(f)) remove(join(dist, f));
  // Images: transformers.js imports sharp when it loads, but cairn never processes an image. A stub
  // at sharp's entry points keeps the import working; the native image libraries go.
  const sharp = inModules("sharp");
  const manifest = readJson(join(sharp, "package.json"));
  if (manifest) {
    const dot = manifest.exports?.["."];
    const entries = new Set([manifest.main, dot?.import?.default ?? dot?.import, dot?.require?.default ?? dot?.require].filter((e) => typeof e === "string"));
    for (const f of children(sharp)) if (f !== "package.json" && f !== "LICENSE") remove(join(sharp, f));
    const thrower = `() => { throw new Error("sharp was removed from this cairn install: cairn never processes images"); }`;
    for (const entry of entries) {
      const file = join(sharp, entry);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, entry.endsWith(".mjs") ? `export default ${thrower};\n` : `module.exports = ${thrower};\n`);
    }
  }
  for (const f of children(inModules("@img"))) if (f.startsWith("sharp-")) remove(inModules("@img", f));
}

/** The MCP SDK's HTTP-server stack: cairn serves MCP over stdio only. */
function mcpHttp() {
  for (const p of ["express", "express-rate-limit", "cors", "hono", join("@hono", "node-server")]) remove(inModules(p));
}

/** Packages nothing that's left depends on (they were only there for what was removed). */
function orphans() {
  const manifest = (dir) => readJson(join(dir, "package.json"));
  const installed = new Map();
  for (const name of children(modules)) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) for (const sub of children(inModules(name))) installed.set(`${name}/${sub}`, inModules(name, sub));
    else installed.set(name, inModules(name));
  }
  const reachable = new Set();
  const visit = (deps) => {
    for (const dep of Object.keys(deps ?? {})) {
      if (reachable.has(dep) || !installed.has(dep)) continue;
      reachable.add(dep);
      const m = manifest(installed.get(dep));
      visit({ ...m?.dependencies, ...m?.optionalDependencies, ...m?.peerDependencies });
    }
  };
  const root = manifest(pkgDir);
  visit({ ...root?.dependencies, ...root?.optionalDependencies });
  for (const [name, dir] of installed) if (!reachable.has(name)) remove(dir);
  for (const scope of children(modules)) if (scope.startsWith("@") && children(inModules(scope)).length === 0) remove(inModules(scope));
}

/** Files nothing reads at runtime: source maps, type declarations, docs. */
function devFiles(dir = modules) {
  for (const f of children(dir)) {
    const path = join(dir, f);
    let s;
    try {
      s = statSync(path);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      if (dir === inModules("@types")) remove(path);
      else devFiles(path);
    } else if (/\.(map|d\.ts|d\.mts|d\.cts|md|markdown)$/i.test(f)) remove(path);
  }
}

// Only for an installed package, never the source checkout (whose node_modules is for development).
if (pkgDir.split("/").includes("node_modules") && existsSync(modules)) {
  const before = size(modules);
  for (const step of [otherPlatforms, transformersExtras, mcpHttp, orphans, devFiles]) {
    try {
      step();
    } catch {
      // A step that fails leaves its files in place.
    }
  }
  const mb = (n) => Math.round(n / 1e6);
  console.log(`cairn: removed unused parts of its dependencies (${mb(before)} MB → ${mb(size(modules))} MB)`);
}
