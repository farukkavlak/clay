/** Counts the writes to each block's instances, so a value built from all of them is built again only after one. */
export class Versions {
  private counts = new Map<string, number>();

  changed(block: string): void {
    this.counts.set(block, this.of(block) + 1);
  }

  of(block: string): number {
    return this.counts.get(block) ?? 0;
  }
}
