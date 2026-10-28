/** Names given so far, and a wait for one, so a test orders work by what it waits for, not by how long each part takes. */
export class Signals {
  private readonly given = new Set<string>();
  private readonly waiting = new Map<string, (() => void)[]>();

  give(name: string): void {
    this.given.add(name);
    for (const wake of this.waiting.get(name) ?? []) wake();
    this.waiting.delete(name);
  }

  /** Resolves once `name` is given, or after `ms` if it never is, so work that waits for the wrong thing fails the test, not hangs it. */
  async wait(name: string, ms = 1000): Promise<void> {
    if (this.given.has(name)) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      const wakes = this.waiting.get(name) ?? [];
      wakes.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.waiting.set(name, wakes);
    });
  }
}
