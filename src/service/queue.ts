/**
 * Runs one job at a time and coalesces triggers: a trigger while the job runs schedules exactly
 * one more run, which every caller during that time shares. The watcher can fire as often as it
 * likes; the store sees one writer and no wasted runs.
 */
export class Coalescer<T> {
  private running: Promise<T> | undefined;
  private next: Promise<T> | undefined;

  constructor(private readonly job: () => Promise<T>) {}

  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Resolves with the result of a run that started at or after this call. */
  trigger(): Promise<T> {
    if (!this.running) return this.run();
    this.next ??= this.running
      .catch(() => undefined)
      .then(() => {
        this.next = undefined;
        return this.run();
      });
    return this.next;
  }

  /** Resolves when nothing is running or scheduled. */
  async idle(): Promise<void> {
    while (this.running || this.next) await (this.next ?? this.running)?.catch(() => undefined);
  }

  private run(): Promise<T> {
    const p: Promise<T> = this.job().finally(() => {
      if (this.running === p) this.running = undefined;
    });
    this.running = p;
    return p;
  }
}
