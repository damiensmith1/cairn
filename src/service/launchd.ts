import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

/** cairnd as a macOS LaunchAgent: started at login, restarted if it crashes. */
export const LABEL = "local.cairn.cairnd";

export const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

/** Environment cairnd needs to find the same data and sessions as the CLI that installed it. */
const PASSED_ENV = ["CAIRN_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_PROJECTS_DIR", "OLLAMA_HOST"];

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The command that runs cairnd: this Node, this CLI (and its loader flags under tsx), `daemon`. */
export function daemonCommand(): string[] {
  return [process.execPath, ...process.execArgv, resolve(process.argv[1]!), "daemon"];
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

/** Writes the LaunchAgent and starts it (replacing an older one). */
export function install(logFile: string): string {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const k of PASSED_ENV) if (process.env[k]) env[k] = process.env[k]!;
  const file = plistPath();
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  writeFileSync(file, plist({ program: daemonCommand(), env, logFile }));
  if (isLoaded()) spawnSync("launchctl", ["bootout", `${domain()}/${LABEL}`], { stdio: "ignore" });
  execFileSync("launchctl", ["bootstrap", domain(), file]);
  return file;
}

/** Stops cairnd and removes the LaunchAgent, so it won't start at login. */
export function uninstall() {
  if (isLoaded()) spawnSync("launchctl", ["bootout", `${domain()}/${LABEL}`], { stdio: "ignore" });
  rmSync(plistPath(), { force: true });
}
