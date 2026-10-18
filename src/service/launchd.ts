import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

/** cairnd as a macOS LaunchAgent: started at login, restarted if it crashes. */
export const LABEL = "local.cairn.cairnd";

export const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

/** Environment cairnd needs to find the same data and sessions as the CLI that installed it. */
const PASSED_ENV = ["CAIRN_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_PROJECTS_DIR", "OLLAMA_HOST"];

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * This Node, by a path that survives upgrades. Homebrew runs Node from a versioned Cellar folder
 * that an upgrade deletes; the PATH entry (/opt/homebrew/bin/node) is a symlink that follows it.
 * Only used when it is the same binary, so a different Node on the PATH isn't swapped in.
 */
export function nodePath(): string {
  const which = spawnSync("which", ["node"], { encoding: "utf8" });
  const found = which.status === 0 ? which.stdout.trim() : "";
  try {
    return found && realpathSync(found) === realpathSync(process.execPath) ? found : process.execPath;
  } catch {
    return process.execPath;
  }
}

/** The command that runs cairnd: this Node, this CLI (and its loader flags under tsx), `daemon`. */
export function daemonCommand(): string[] {
  return [nodePath(), ...process.execArgv, resolve(process.argv[1]!), "daemon"];
}

export function plist(options: { program: string[]; env: Record<string, string>; logFile: string }): string {
  const env = Object.entries(options.env)
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${options.program.map((a) => `      <string>${xml(a)}</string>`).join("\n")}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <!-- Restart after a crash, not after a clean stop. -->
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <!-- Not "Background": macOS then throttles CPU and disk, and searches took 6-44 s instead of
         ~0.5 s (docs/experiments.md). The heavy part of indexing runs in Ollama anyway. -->
    <key>ProcessType</key>
    <string>Standard</string>
    <key>StandardOutPath</key>
    <string>${xml(options.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(options.logFile)}</string>
  </dict>
</plist>
`;
}

const domain = () => `gui/${userInfo().uid}`;

export function isLoaded(): boolean {
  return spawnSync("launchctl", ["print", `${domain()}/${LABEL}`], { stdio: "ignore" }).status === 0;
}

/** Stops the service and waits until launchd has let go of it: bootout returns before that. */
async function bootout() {
  if (!isLoaded()) return;
  spawnSync("launchctl", ["bootout", `${domain()}/${LABEL}`], { stdio: "ignore" });
  for (let i = 0; i < 40 && isLoaded(); i++) await new Promise((r) => setTimeout(r, 250));
}

/** Writes the LaunchAgent and starts it (replacing an older one). */
export async function install(logFile: string): Promise<string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const k of PASSED_ENV) if (process.env[k]) env[k] = process.env[k]!;
  const file = plistPath();
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  writeFileSync(file, plist({ program: daemonCommand(), env, logFile }));
  await bootout();
  // launchd can still be releasing the old instance for a moment after bootout ("Bootstrap
  // failed: 5"), so retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync("launchctl", ["bootstrap", domain(), file], { stdio: "pipe" });
      return file;
    } catch (e) {
      if (attempt >= 8) throw new Error(`launchctl couldn't start cairnd: ${String((e as { stderr?: Buffer }).stderr ?? e).trim()}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/**
 * Installs and starts cairnd, then waits until it answers on its socket (its first catch-up can
 * keep it busy for a while). Returns the plist path, or throws if it never answers.
 */
export async function startService(logFile: string, socket: string, connect: (path: string, timeoutMs: number) => Promise<{ close(): void } | undefined>): Promise<string> {
  const file = await install(logFile);
  for (let i = 0; i < 60; i++) {
    const c = await connect(socket, 1000);
    if (c) {
      c.close();
      return file;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`cairnd was installed but isn't answering yet; see ${logFile}`);
}

/** Stops cairnd and removes the LaunchAgent, so it won't start at login. */
export async function uninstall() {
  await bootout();
  rmSync(plistPath(), { force: true });
}
