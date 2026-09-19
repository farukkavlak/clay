export class Graph<T> {
  private nodes: Map<string, T> = new Map();
  private adjacencyList: Map<string, Set<string>> = new Map();

  addNode(id: string, data: T): void {
    if (this.nodes.has(id)) throw new Error(`Node ${id} already exists`);
    this.nodes.set(id, data);
    this.adjacencyList.set(id, new Set());
  }

  addEdge(from: string, to: string): void {
    if (!this.nodes.has(from)) throw new Error(`Node ${from} does not exist`);
    if (!this.nodes.has(to)) throw new Error(`Node ${to} does not exist`);

    this.adjacencyList.get(from)!.add(to);
  }

  getNode(id: string): T | undefined {
    return this.nodes.get(id);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  /*
   * Returns nodes in topological order, grouped by layers for parallel execution.
   * Format: [['A', 'B'], ['C']] -> A and B can run in parallel, then C.
   */
  topologicalSort(): string[][] {
    const inDegree = this.calculateInDegrees();
    const result: string[][] = [];
    let queue: string[] = [];

    for (const [node, degree] of inDegree.entries()) if (degree === 0) queue.push(node);

    while (queue.length > 0) {
      const currentLayer = [...queue];
      result.push(currentLayer);

      const nextQueue: string[] = [];

      for (const node of currentLayer) {
        const neighbors = this.adjacencyList.get(node)!;
        for (const neighbor of neighbors) {
          const newDegree = inDegree.get(neighbor)! - 1;
          inDegree.set(neighbor, newDegree);
          if (newDegree === 0) nextQueue.push(neighbor);
        }
      }

      queue = nextQueue;
    }

    const totalNodes = result.reduce((acc, layer) => acc + layer.length, 0);
    // Reversed, so each arrow points from a node to what it depends on.
    if (totalNodes !== this.nodes.size) throw new Error(`Dependency cycle detected: ${this.findCycle().reverse().join(' -> ')}`);

    return result;
  }

  /** Walks the graph depth first and returns the first path that comes back to a node it is still visiting. */
  private findCycle(): string[] {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const path: string[] = [];

    const walk = (node: string): string[] | null => {
      visiting.add(node);
      path.push(node);

      for (const neighbor of this.adjacencyList.get(node)!) {
        if (visiting.has(neighbor)) return [...path.slice(path.indexOf(neighbor)), neighbor];
        if (!visited.has(neighbor)) {
          const cycle = walk(neighbor);
          if (cycle) return cycle;
        }
      }

      path.pop();
      visiting.delete(node);
      visited.add(node);
      return null;
    };

    for (const node of this.nodes.keys())
      if (!visited.has(node)) {
        const cycle = walk(node);
        if (cycle) return cycle;
      }

    return [];
  }

  private calculateInDegrees(): Map<string, number> {
    const inDegree: Map<string, number> = new Map();

    for (const node of this.nodes.keys()) inDegree.set(node, 0);

    for (const neighbors of this.adjacencyList.values()) for (const neighbor of neighbors) inDegree.set(neighbor, (inDegree.get(neighbor) || 0) + 1);

    return inDegree;
  }
}
