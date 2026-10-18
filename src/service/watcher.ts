import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";

export interface WatchOptions {
  /** Wait this long after the last change before firing, so a burst of writes is one run. */
  debounceMs?: number;
  /**
   * Also fire on this interval: catches events the OS dropped, and lets exchanges that went idle
   * (which no file change announces) count as complete.
   */
  sweepMs?: number;
}

/**
 * Calls `onChange` with the logs that changed (paths relative to their root) once writes settle,
 * and with "sweep" on every sweep. Returns a stop function.
 */
export function watchSources(roots: string[], onChange: (reason: "change" | "sweep", files: string[]) => void, options: WatchOptions = {}): () => void {
  const debounceMs = options.debounceMs ?? 2000;
  let timer: NodeJS.Timeout | undefined;
  const files = new Set<string>();
  const changed = (file: string) => {
    files.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const batch = [...files];
      files.clear();
      onChange("change", batch);
    }, debounceMs);
  };
  const watchers: FSWatcher[] = [];
  for (const root of roots) {
    try {
      // Recursive watching uses FSEvents on macOS; a missing folder is left to the sweep.
      const w = watch(root, { recursive: true }, (_event, file) => {
        if (!file || String(file).endsWith(".jsonl")) changed(file ? String(file) : "");
      });
      w.on("error", () => w.close());
      watchers.push(w);
    } catch {
      // folder doesn't exist yet
    }
  }
  const sweep = setInterval(() => onChange("sweep", []), options.sweepMs ?? 60_000);
  return () => {
    clearTimeout(timer);
    clearInterval(sweep);
    for (const w of watchers) w.close();
  };
}
