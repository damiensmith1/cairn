import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** cairn's data folder: `~/.cairn`, or `CAIRN_HOME`. */
export const cairnHome = () => process.env.CAIRN_HOME ?? join(homedir(), ".cairn");

export const dbPath = () => join(cairnHome(), "cairn.db");

/** Where cairnd listens; clients connect here. */
export const socketPath = () => join(cairnHome(), "cairnd.sock");

export const logDir = () => join(cairnHome(), "logs");

export const labelModelPath = () => join(cairnHome(), "models", "labels.json");

/**
 * Claude Code's transcripts. Follows Claude Code's own `CLAUDE_CONFIG_DIR` (it writes
 * `<config dir>/projects`), so cairn reads wherever Claude Code writes. `CLAUDE_PROJECTS_DIR`
 * points at the projects folder directly and wins over both.
 */
export const claudeProjectsDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.CLAUDE_PROJECTS_DIR ?? join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

/** Where this cairn is installed: one level above src/ or dist/, wherever this module ended up. */
export const cairnRoot = () => dirname(dirname(fileURLToPath(import.meta.url)));

/** The version of this cairn, from its package.json. */
export function cairnVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(cairnRoot(), "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}
