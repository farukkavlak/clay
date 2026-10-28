import { describe, expect, it } from 'vitest';

import { Graph } from '../src/Graph';

/** The nodes of each component, sorted. */
function groups(graph: Graph<string>): string[][] {
  const byRoot = new Map<string, string[]>();
  for (const [node, root] of graph.components()) byRoot.set(root, [...(byRoot.get(root) ?? []), node]);
  return [...byRoot.values()].map((nodes) => nodes.sort()).sort((a, b) => a[0].localeCompare(b[0]));
}

describe('Graph', () => {
  it('should add nodes', () => {
    const graph = new Graph<string>();
    graph.addNode('A', 'Data A');
    expect(graph.getNode('A')).toBe('Data A');
  });

  it('should throw when adding duplicate node', () => {
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    expect(() => graph.addNode('A', 'val2')).toThrow(/exists/);
  });

  it('should sort nodes topologically (simple)', () => {
    // A -> B
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    graph.addNode('B', 'val');
    graph.addEdge('A', 'B');

    const sorted = graph.topologicalSort();
    expect(sorted.flat()).toEqual(['A', 'B']);
  });

  it('should sort nodes topologically (complex)', () => {
    // A -> B, A -> C, B -> D, C -> D
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    graph.addNode('B', 'val');
    graph.addNode('C', 'val');
    graph.addNode('D', 'val');

    graph.addEdge('A', 'B');
    graph.addEdge('A', 'C');
    graph.addEdge('B', 'D');
    graph.addEdge('C', 'D');

    const sorted = graph.topologicalSort();

    expect(sorted).toHaveLength(3);
    expect(sorted[0]).toEqual(['A']);
    expect(sorted[1]).toContain('B');
    expect(sorted[1]).toContain('C');
    expect(sorted[2]).toEqual(['D']);
  });

  it('should detect cycles', () => {
    // A -> B -> A
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    graph.addNode('B', 'val');
    graph.addEdge('A', 'B');
    graph.addEdge('B', 'A');

    expect(() => graph.topologicalSort()).toThrow('Dependency cycle detected: A -> B -> A');
  });

  it('should point each arrow at what the node depends on', () => {
    // A depends on B, B on C, C on A.
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    graph.addNode('B', 'val');
    graph.addNode('C', 'val');
    graph.addEdge('C', 'B');
    graph.addEdge('B', 'A');
    graph.addEdge('A', 'C');

    expect(() => graph.topologicalSort()).toThrow('Dependency cycle detected: A -> B -> C -> A');
  });

  it('finds a cycle as the nodes each one depends on, and nothing in a graph without one', () => {
    // A depends on B, B on C.
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    graph.addNode('B', 'val');
    graph.addNode('C', 'val');
    graph.addEdge('C', 'B');
    graph.addEdge('B', 'A');

    expect(graph.findCycle()).toBeUndefined();

    graph.addEdge('A', 'C');

    expect(graph.findCycle()).toEqual(['A', 'B', 'C', 'A']);
  });

  it('finds no cycle where two paths meet again', () => {
    // D depends on B and C, which both depend on A.
    const graph = new Graph<string>();
    for (const node of ['A', 'B', 'C', 'D']) graph.addNode(node, 'val');
    graph.addEdge('A', 'B');
    graph.addEdge('A', 'C');
    graph.addEdge('B', 'D');
    graph.addEdge('C', 'D');

    expect(graph.findCycle()).toBeUndefined();
  });

  it('finds only the cycle, not the path that leads into it', () => {
    // A depends on X and on B, B on C, C on A. X comes first, so the search starts outside the cycle.
    const graph = new Graph<string>();
    for (const node of ['X', 'A', 'B', 'C']) graph.addNode(node, 'val');
    graph.addEdge('X', 'A');
    graph.addEdge('C', 'B');
    graph.addEdge('B', 'A');
    graph.addEdge('A', 'C');

    expect(graph.findCycle()).toEqual(['A', 'B', 'C', 'A']);
  });

  it('finds a cycle through a chain longer than the call stack holds, and nothing in it before it closes', () => {
    const length = 20_000;
    const graph = new Graph<string>();
    for (let i = 0; i < length; i++) graph.addNode(`n${i}`, 'val');
    for (let i = 1; i < length; i++) graph.addEdge(`n${i - 1}`, `n${i}`);

    expect(graph.findCycle()).toBeUndefined();

    graph.addEdge(`n${length - 1}`, 'n0');
    const cycle = graph.findCycle()!;

    expect(cycle).toHaveLength(length + 1);
    expect([cycle[0], cycle[1], cycle.at(-2), cycle.at(-1)]).toEqual(['n0', `n${length - 1}`, 'n1', 'n0']);
  });

  describe('components', () => {
    it('groups the nodes that reach each other, apart from what leads in and out', () => {
      const graph = new Graph<string>();
      for (const node of ['X', 'A', 'B', 'C', 'Y']) graph.addNode(node, 'val');
      graph.addEdge('X', 'A');
      graph.addEdge('A', 'B');
      graph.addEdge('B', 'C');
      graph.addEdge('C', 'A');
      graph.addEdge('C', 'Y');

      expect(groups(graph)).toEqual([['A', 'B', 'C'], ['X'], ['Y']]);
    });

    it('keeps two nodes that one reaches the other apart', () => {
      const graph = new Graph<string>();
      for (const node of ['A', 'B']) graph.addNode(node, 'val');
      graph.addEdge('B', 'A');

      expect(groups(graph)).toEqual([['A'], ['B']]);
    });

    it('walks a chain longer than the call stack holds', () => {
      const length = 20_000;
      const graph = new Graph<string>();
      for (let i = 0; i < length; i++) graph.addNode(`n${i}`, 'val');
      for (let i = 1; i < length; i++) graph.addEdge(`n${i - 1}`, `n${i}`);

      expect(new Set(graph.components().values()).size).toBe(length);

      graph.addEdge(`n${length - 1}`, 'n0');

      expect(new Set(graph.components().values()).size).toBe(1);
    });
  });

  it('should list every node with its data', () => {
    const graph = new Graph<string>();
    graph.addNode('A', 'first');
    graph.addNode('B', 'second');

    expect([...graph.entries()]).toEqual([
      ['A', 'first'],
      ['B', 'second'],
    ]);
  });

  it('should list what a node depends on', () => {
    const graph = new Graph<string>();
    graph.addNode('A', '');
    graph.addNode('B', '');
    graph.addNode('C', '');
    graph.addEdge('A', 'C');
    graph.addEdge('B', 'C');

    expect(graph.dependenciesOf('C').sort()).toEqual(['A', 'B']);
    expect(graph.dependenciesOf('A')).toEqual([]);
    expect(() => graph.dependenciesOf('D')).toThrow('Node D does not exist');
  });

  it('should list what depends on a node', () => {
    const graph = new Graph<string>();
    graph.addNode('A', '');
    graph.addNode('B', '');
    graph.addNode('C', '');
    graph.addEdge('A', 'B');
    graph.addEdge('A', 'C');

    expect(graph.dependentsOf('A').sort()).toEqual(['B', 'C']);
    expect(graph.dependentsOf('B')).toEqual([]);
    expect(() => graph.dependentsOf('D')).toThrow('Node D does not exist');
  });

  it('should detect self-reference cycle', () => {
    // A -> A
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    graph.addEdge('A', 'A');

    expect(() => graph.topologicalSort()).toThrow(/cycle detected/);
  });

  it('should detect multi-node cycle', () => {
    // A -> B -> C -> A
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    graph.addNode('B', 'val');
    graph.addNode('C', 'val');
    graph.addEdge('A', 'B');
    graph.addEdge('B', 'C');
    graph.addEdge('C', 'A');

    expect(() => graph.topologicalSort()).toThrow(/cycle detected/);
  });

  it('should detect cycle in complex graph', () => {
    // A -> B -> D, A -> C -> D, D -> B
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    graph.addNode('B', 'val');
    graph.addNode('C', 'val');
    graph.addNode('D', 'val');
    graph.addEdge('A', 'B');
    graph.addEdge('A', 'C');
    graph.addEdge('B', 'D');
    graph.addEdge('C', 'D');
    graph.addEdge('D', 'B');

    expect(() => graph.topologicalSort()).toThrow(/cycle detected/);
  });

  it('should sort nodes batch-wise (parallel)', () => {
    // A -> C, B -> C, and D on its own
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    graph.addNode('B', 'val');
    graph.addNode('C', 'val');
    graph.addNode('D', 'val');

    graph.addEdge('A', 'C');
    graph.addEdge('B', 'C');

    const batches = graph.topologicalSort();

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0]).toContain('A');
    expect(batches[0]).toContain('B');
    expect(batches[0]).toContain('D');

    expect(batches[1]).toEqual(['C']);
  });

  it('puts a node that takes no layer in the layer of what follows it', () => {
    // A and B go before W, which goes before C; D goes after A alone.
    const graph = new Graph<string>();
    for (const node of ['A', 'B', 'W', 'C', 'D']) graph.addNode(node, 'val');
    graph.addEdge('A', 'W');
    graph.addEdge('B', 'W');
    graph.addEdge('W', 'C');
    graph.addEdge('A', 'D');

    expect(graph.topologicalSort((node) => node === 'W')).toEqual([
      ['A', 'B'],
      ['D', 'W', 'C'],
    ]);
    expect(graph.topologicalSort()).toEqual([['A', 'B'], ['D', 'W'], ['C']]);
  });

  it('should throw when adding edge from non-existent node', () => {
    const graph = new Graph<string>();
    graph.addNode('B', 'val');
    expect(() => graph.addEdge('A', 'B')).toThrow(/node a does not exist/i);
  });

  it('should throw when adding edge to non-existent node', () => {
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    expect(() => graph.addEdge('A', 'Z')).toThrow(/node z does not exist/i);
  });

  it('should check if node exists', () => {
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    expect(graph.hasNode('A')).toBe(true);
    expect(graph.hasNode('B')).toBe(false);
  });
});
