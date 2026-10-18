import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { cairnHome } from "./paths.js";

/** ~/.cairn/config.toml: what `cairn init` chose. Absent means defaults. */
export interface CairnConfig {
  sources?: {
    "claude-code"?: { enabled: boolean; paths: string[] };
  };
}

export const configPath = () => join(cairnHome(), "config.toml");

/** `~/x` → an absolute path. */
export const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** An absolute path under the home folder → `~/x`, for config files and display. */
export const tildify = (p: string) => (p.startsWith(`${homedir()}/`) ? `~/${p.slice(homedir().length + 1)}` : p);

export function loadConfig(file = configPath()): CairnConfig | undefined {
  if (!existsSync(file)) return undefined;
  return parse(readFileSync(file, "utf8")) as CairnConfig;
}

/** Writes the config atomically (temp file, then rename), owner-only. */
export function saveConfig(config: CairnConfig, file = configPath()): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `# Written by cairn init. Re-run it to change these.\n${stringify(config)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
