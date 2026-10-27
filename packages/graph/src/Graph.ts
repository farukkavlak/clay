export class Graph<T> {
  private nodes: Map<string, T> = new Map();
  private adjacencyList: Map<string, Set<string>> = new Map();
  /** The edges turned around, so what a node depends on is read without scanning every node. */
  private reverseList: Map<string, Set<string>> = new Map();

  addNode(id: string, data: T): void {
    if (this.nodes.has(id)) throw new Error(`Node ${id} already exists`);
    this.nodes.set(id, data);
    this.adjacencyList.set(id, new Set());
    this.reverseList.set(id, new Set());
  }

  addEdge(from: string, to: string): void {
    if (!this.nodes.has(from)) throw new Error(`Node ${from} does not exist`);
    if (!this.nodes.has(to)) throw new Error(`Node ${to} does not exist`);

    this.adjacencyList.get(from)!.add(to);
    this.reverseList.get(to)!.add(from);
  }

  getNode(id: string): T | undefined {
    return this.nodes.get(id);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  entries(): IterableIterator<[string, T]> {
    return this.nodes.entries();
  }

  /** Nodes with an edge into this one. */
  dependenciesOf(id: string): string[] {
    if (!this.nodes.has(id)) throw new Error(`Node ${id} does not exist`);

    return [...this.reverseList.get(id)!];
  }

  /** Nodes this one has an edge into. */
  dependentsOf(id: string): string[] {
    if (!this.nodes.has(id)) throw new Error(`Node ${id} does not exist`);

    return [...this.adjacencyList.get(id)!];
  }

  /**
   * Layers in dependency order; the nodes of one layer could run in parallel.
   * A node `takesNoLayer` names is in the layer of the first node after it, so what follows it is not held back a layer.
   */
  topologicalSort(takesNoLayer: (id: string) => boolean = () => false): string[][] {
    const { order, layerOf } = this.layered(takesNoLayer);
    if (order.length !== this.nodes.size) throw new Error(`Dependency cycle detected: ${this.findCycle()!.join(' -> ')}`);

    const result: string[][] = [];
    for (const node of order) (result[layerOf.get(node) ?? 0] ??= []).push(node);

    return result;
  }

  /** Each node once every node before it is placed, with its layer; a node in a cycle is never placed. */
  private layered(takesNoLayer: (id: string) => boolean): { order: string[]; layerOf: Map<string, number> } {
    const inDegree = this.calculateInDegrees();
    const layerOf = new Map<string, number>();
    const order = [...inDegree].filter(([, degree]) => degree === 0).map(([node]) => node);

    for (let index = 0; index < order.length; index++) {
      const node = order[index];
      const after = (layerOf.get(node) ?? 0) + (takesNoLayer(node) ? 0 : 1);

      for (const neighbor of this.adjacencyList.get(node)!) {
        layerOf.set(neighbor, Math.max(layerOf.get(neighbor) ?? 0, after));
        inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
        if (inDegree.get(neighbor) === 0) order.push(neighbor);
      }
    }

    return { order, layerOf };
  }

  /** The first cycle found, each node followed by one it depends on. */
  findCycle(): string[] | undefined {
    const visited = new Set<string>();

    for (const node of this.nodes.keys())
      if (!visited.has(node)) {
        const cycle = this.cycleFrom(node, visited);
        // Reversed, since an edge points from a node to what depends on it.
        if (cycle) return cycle.reverse();
      }

    return undefined;
  }

  /** Depth first with a stack of its own, since a chain can be longer than the call stack. */
  private cycleFrom(start: string, visited: Set<string>): string[] | undefined {
    const path = [start];
    const visiting = new Set(path);
    const untried = [this.adjacencyList.get(start)!.values()];

    while (path.length > 0) {
      const next = untried.at(-1)!.next();

      if (next.done) {
        const node = path.pop()!;
        untried.pop();
        visiting.delete(node);
        visited.add(node);
      } else if (visiting.has(next.value)) return [...path.slice(path.indexOf(next.value)), next.value];
      else if (!visited.has(next.value)) {
        path.push(next.value);
        visiting.add(next.value);
        untried.push(this.adjacencyList.get(next.value)!.values());
      }
    }

    return undefined;
  }

  /** Each node to a node of its strongly connected component, the same for every node of it: two nodes share one when each reaches the other. */
  components(): Map<string, string> {
    const component = new Map<string, string>();

    for (const root of this.finishOrder().reverse()) {
      if (component.has(root)) continue;

      component.set(root, root);
      const stack = [root];
      for (let at = stack.pop(); at !== undefined; at = stack.pop())
        for (const from of this.reverseList.get(at)!)
          if (!component.has(from)) {
            component.set(from, root);
            stack.push(from);
          }
    }

    return component;
  }

  /** Every node, each after every node it reaches first; depth first with a stack of its own. */
  private finishOrder(): string[] {
    const finished: string[] = [];
    const seen = new Set<string>();

    for (const start of this.nodes.keys()) {
      if (seen.has(start)) continue;

      seen.add(start);
      const path = [start];
      const untried = [this.adjacencyList.get(start)!.values()];

      while (path.length > 0) {
        const next = untried.at(-1)!.next();

        if (next.done) {
          finished.push(path.pop()!);
          untried.pop();
        } else if (!seen.has(next.value)) {
          seen.add(next.value);
          path.push(next.value);
          untried.push(this.adjacencyList.get(next.value)!.values());
        }
      }
    }

    return finished;
  }

  private calculateInDegrees(): Map<string, number> {
    const inDegree: Map<string, number> = new Map();

    for (const node of this.nodes.keys()) inDegree.set(node, 0);

    for (const neighbors of this.adjacencyList.values()) for (const neighbor of neighbors) inDegree.set(neighbor, (inDegree.get(neighbor) || 0) + 1);

    return inDegree;
  }
}
