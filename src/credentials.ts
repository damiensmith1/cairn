import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cairnHome } from "./paths.js";

/** Where cairn keeps the Anthropic API key that `cairn ask` uses. */
export interface KeyStore {
  /** Shown to the user: where the key lives. */
  readonly where: string;
  get(): string | undefined;
  set(key: string): void;
  delete(): void;
}

const SERVICE = "cairn.anthropic-api-key";
const ACCOUNT = "cairn";

/** A plausible Anthropic API key: the right prefix, no whitespace or quotes. */
export function looksLikeKey(key: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key);
}

/** The `security -i` command that stores a key. Exported for tests; never logged. */
export function keychainAddCommand(key: string, keychain?: string): string {
  if (!looksLikeKey(key)) throw new Error("that doesn't look like an Anthropic API key (sk-ant-…)");
  return `add-generic-password -U -a ${ACCOUNT} -s ${SERVICE} -l "cairn: Anthropic API key" -w "${key}"${keychain ? ` "${keychain}"` : ""}\n`;
}

/**
 * The macOS Keychain: encrypted at rest with the user's login, not in any file, backup, shell
 * history or environment. Apps reading it through the Keychain API get a system prompt; the
 * `security` tool itself is on the item's access list (it wrote it), so anything running as the
 * user can still read it that way, as with any CLI-stored item. The key is written through
 * `security -i` reading commands from stdin, so it never appears in a process's arguments.
 */
export class KeychainStore implements KeyStore {
  readonly where = "macOS Keychain";

  /** `keychain`: a keychain file other than the default (tests use a throwaway one). */
  constructor(private readonly keychain?: string) {}

  private get target() {
    return this.keychain ? [this.keychain] : [];
  }

  get(): string | undefined {
    const r = spawnSync("security", ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w", ...this.target], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() || undefined : undefined;
  }

  set(key: string): void {
    const r = spawnSync("security", ["-i"], { input: keychainAddCommand(key, this.keychain), encoding: "utf8" });
    if (r.status !== 0 || /error|failed/i.test(r.stderr)) throw new Error(`couldn't store the key in the Keychain: ${r.stderr.trim()}`);
    if (this.get() !== key) throw new Error("the Keychain didn't keep the key");
  }

  delete(): void {
    spawnSync("security", ["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE, ...this.target], { stdio: "ignore" });
  }
}

/** Fallback where there's no Keychain: an owner-only file under ~/.cairn. */
export class FileStore implements KeyStore {
  constructor(private readonly file = join(cairnHome(), "credentials")) {}

  get where() {
    return this.file;
  }

  get(): string | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      return (JSON.parse(readFileSync(this.file, "utf8")) as { anthropicApiKey?: string }).anthropicApiKey;
    } catch {
      return undefined;
    }
  }

  set(key: string): void {
    if (!looksLikeKey(key)) throw new Error("that doesn't look like an Anthropic API key (sk-ant-…)");
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ anthropicApiKey: key }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  delete(): void {
    rmSync(this.file, { force: true });
  }
}

export const keyStore = (): KeyStore => (process.platform === "darwin" ? new KeychainStore() : new FileStore());

/** The key `cairn ask` uses: ANTHROPIC_API_KEY if set, else the stored one. */
export function anthropicKey(store: KeyStore = keyStore()): { key: string; from: string } | undefined {
  if (process.env.ANTHROPIC_API_KEY) return { key: process.env.ANTHROPIC_API_KEY, from: "ANTHROPIC_API_KEY" };
  const key = store.get();
  return key ? { key, from: store.where } : undefined;
}
