import { homedir } from "node:os";
import { join } from "node:path";

/** cairn's data folder: `~/.cairn`, or `CAIRN_HOME`. */
export const cairnHome = () => process.env.CAIRN_HOME ?? join(homedir(), ".cairn");

export const dbPath = () => join(cairnHome(), "cairn.db");

/**
 * Claude Code's transcripts. Follows Claude Code's own `CLAUDE_CONFIG_DIR` (it writes
 * `<config dir>/projects`), so cairn reads wherever Claude Code writes. `CLAUDE_PROJECTS_DIR`
 * points at the projects folder directly and wins over both.
 */
export const claudeProjectsDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.CLAUDE_PROJECTS_DIR ?? join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
