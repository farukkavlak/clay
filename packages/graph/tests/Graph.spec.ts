import { describe, expect, it } from 'vitest';

import { Graph } from '../src/Graph';

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
    // A -> B (A comes before B)
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    graph.addNode('B', 'val');
    graph.addEdge('A', 'B');

    const sorted = graph.topologicalSort();
    // Expect: [['A'], ['B']] or [['A', 'B']] depending on implementation details of simple graph
    expect(sorted.flat()).toEqual(['A', 'B']);
  });

  it('should sort nodes topologically (complex)', () => {
    // A -> B, A -> C, B -> D, C -> D
    // Expect: A, then B/C, then D.
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
    // Layers: [['A'], ['B', 'C'], ['D']]

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
    // C is needed by B, B by A: A depends on B depends on C depends on A.
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    graph.addNode('B', 'val');
    graph.addNode('C', 'val');
    graph.addEdge('C', 'B');
    graph.addEdge('B', 'A');
    graph.addEdge('A', 'C');

    expect(() => graph.topologicalSort()).toThrow('Dependency cycle detected: A -> B -> C -> A');
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
    // A -> B -> D
    // A -> C -> D (cycle: D -> B)
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    graph.addNode('B', 'val');
    graph.addNode('C', 'val');
    graph.addNode('D', 'val');
    graph.addEdge('A', 'B');
    graph.addEdge('A', 'C');
    graph.addEdge('B', 'D');
    graph.addEdge('C', 'D');
    graph.addEdge('D', 'B'); // Creates cycle

    expect(() => graph.topologicalSort()).toThrow(/cycle detected/);
  });

  it('should sort nodes batch-wise (parallel)', () => {
    // A -> C
    // B -> C
    // D (independent)
    // Expect: [[A, B, D], [C]] or similar layers
    const graph = new Graph<string>();
    graph.addNode('A', 'val');
    graph.addNode('B', 'val');
    graph.addNode('C', 'val');
    graph.addNode('D', 'val');

    graph.addEdge('A', 'C');
    graph.addEdge('B', 'C');

    const batches = graph.topologicalSort();

    // First layer should contain A, B, D (order within layer doesn't matter)
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0]).toContain('A');
    expect(batches[0]).toContain('B');
    expect(batches[0]).toContain('D');

    // Second layer should be C
    expect(batches[1]).toEqual(['C']);
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
