/** What a walk needs of a graph. */
interface Edges {
  dependenciesOf(id: string): string[];
  dependentsOf(id: string): string[];
}

type Visit = (id: string) => Promise<void> | void;

/** One walk: each node starts once the nodes it depends on are done, and the walk ends when nothing runs. */
class Walk {
  private readonly place: Map<string, number>;
  private readonly left: Map<string, number>;
  private running = 0;
  private failed?: { at: number; error: unknown };

  constructor(
    private readonly order: string[],
    private readonly edges: Edges,
    private readonly visit: Visit,
    private readonly end: (failed?: { error: unknown }) => void
  ) {
    this.place = new Map(order.map((id, index) => [id, index]));
    this.left = new Map(order.map((id) => [id, edges.dependenciesOf(id).length]));
  }

  begin(): void {
    this.start(this.order.filter((id) => this.left.get(id) === 0));
    this.endIfDone();
  }

  /** In the order, and after a failure only those the order meets before it. */
  private start(ids: string[]): void {
    for (const id of ids.sort((one, other) => this.place.get(one)! - this.place.get(other)!)) {
      if (this.failed && this.place.get(id)! > this.failed.at) continue;

      this.running += 1;
      void this.run(id);
    }
  }

  /** Every failure of a visit is the walk's, which it throws once nothing runs. */
  private async run(id: string): Promise<void> {
    // After the caller has started all it can, so a visit that throws at once cannot end the walk before the others begin.
    await Promise.resolve();
    try {
      await this.visit(id);
    } catch (error) {
      this.fail(id, error);
      return;
    }
    this.visited(id);
  }

  private visited(id: string): void {
    this.running -= 1;
    const ready = this.edges.dependentsOf(id).filter((next) => {
      this.left.set(next, this.left.get(next)! - 1);
      return this.left.get(next) === 0;
    });
    this.start(ready);
    this.endIfDone();
  }

  private fail(id: string, error: unknown): void {
    this.running -= 1;
    const at = this.place.get(id)!;
    if (!this.failed || at < this.failed.at) this.failed = { at, error };
    this.endIfDone();
  }

  private endIfDone(): void {
    if (this.running === 0) this.end(this.failed);
  }
}

/**
 * Visits each node once every node it depends on has been visited, all that are ready at once. Once a visit fails, a node starts only
 * if `order` meets it before that one, and the failure thrown is the first `order` meets, as a walk one node at a time would find it.
 */
export function walk(order: string[], edges: Edges, visit: Visit): Promise<void> {
  return new Promise((resolve, reject) => {
    new Walk(order, edges, visit, (failed) => (failed ? reject(failed.error) : resolve())).begin();
  });
}
