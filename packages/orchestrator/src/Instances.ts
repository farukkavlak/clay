/** Which resource blocks make instances with `count`, by the address of the block, and how many each makes once its count is read. */
export class Instances {
  private counted = new Set<string>();
  private counts = new Map<string, number>();

  clear(): void {
    this.counted.clear();
    this.counts.clear();
  }

  declare(block: string): void {
    this.counted.add(block);
  }

  isCounted(block: string): boolean {
    return this.counted.has(block);
  }

  setCount(block: string, count: number): void {
    this.counts.set(block, count);
  }

  /** Nothing until a plan reads the count; an apply runs the instances its plan listed. */
  countOf(block: string): number | undefined {
    return this.counts.get(block);
  }
}
