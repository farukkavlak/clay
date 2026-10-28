import { describe, expect, it } from 'vitest';

import { Signals } from '../../../tests/signals';
import { Graph } from '../src/Graph';

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Each `[from, to]` an edge from a node to one that depends on it. */
function graphOf(nodes: string[], edges: [string, string][] = []): Graph<string> {
  const graph = new Graph<string>();
  for (const node of nodes) graph.addNode(node, node);
  for (const [from, to] of edges) graph.addEdge(from, to);
  return graph;
}

function throwAtOnce(): never {
  throw new Error('at once');
}

interface Step {
  ms?: number;
  fails?: boolean;
  /** A node this one ends only after. */
  after?: string;
}

/** Logs when each visit starts and ends, waits as `steps` say, and fails where they say. */
function visitor(steps: Record<string, Step> = {}) {
  const log: string[] = [];
  const ended = new Signals();
  let running = 0;
  let most = 0;
  const visit = async (id: string) => {
    running += 1;
    most = Math.max(most, running);
    log.push(`start ${id}`);
    await pause(steps[id]?.ms ?? 0);
    if (steps[id]?.after) await ended.wait(steps[id].after);
    running -= 1;
    if (steps[id]?.fails) throw new Error(`${id} failed`);
    log.push(`end ${id}`);
    ended.give(id);
  };

  return { visit, log, most: () => most };
}

describe('a walk over a graph', () => {
  it('visits each node after every node it depends on', async () => {
    const graph = graphOf(
      ['a', 'b', 'c', 'd'],
      [
        ['a', 'b'],
        ['a', 'c'],
        ['b', 'd'],
        ['c', 'd'],
      ]
    );
    const { visit, log } = visitor({ b: { ms: 10 } });

    await graph.walk(visit);

    expect(log.indexOf('start d')).toBeGreaterThan(Math.max(log.indexOf('end b'), log.indexOf('end c')));
    expect(log.indexOf('start b')).toBeGreaterThan(log.indexOf('end a'));
    expect(log.filter((entry) => entry.startsWith('start'))).toHaveLength(4);
  });

  it('visits every node that is ready at once', async () => {
    const { visit, most } = visitor({ a: { ms: 10 }, b: { ms: 10 }, c: { ms: 10 } });

    await graphOf(['a', 'b', 'c']).walk(visit);

    expect(most()).toBe(3);
  });

  // `a` ends only after `c`. In layers, `c` would wait for `a`, which is in the layer before it, and `a` would end a second later.
  it('visits a node once what it depends on is done, though a node before it in the order still runs', async () => {
    const { visit, log } = visitor({ a: { after: 'c' } });

    await graphOf(['a', 'b', 'c'], [['b', 'c']]).walk(visit);

    expect(log.filter((entry) => entry.startsWith('end'))).toEqual(['end b', 'end c', 'end a']);
  });

  it('starts nothing the order meets after a failure, and lets the visits running end', async () => {
    const { visit, log } = visitor({ a: { fails: true }, b: { ms: 20 } });

    await expect(graphOf(['a', 'b', 'c'], [['b', 'c']]).walk(visit)).rejects.toThrow('a failed');
    expect(log).toContain('end b');
    expect(log).not.toContain('start c');
  });

  it('never visits what depends on a failed node', async () => {
    const { visit, log } = visitor({ a: { fails: true } });

    await expect(graphOf(['a', 'b'], [['a', 'b']]).walk(visit)).rejects.toThrow('a failed');
    expect(log).toEqual(['start a']);
  });

  it('refuses a cycle before it visits anything', async () => {
    const { visit, log } = visitor();

    await expect(
      graphOf(
        ['a', 'b'],
        [
          ['a', 'b'],
          ['b', 'a'],
        ]
      ).walk(visit)
    ).rejects.toThrow('Dependency cycle detected');
    expect(log).toEqual([]);
  });

  it('throws the failure the order meets first, not the first to come', async () => {
    const { visit } = visitor({ a: { ms: 20, fails: true }, b: { fails: true } });

    await expect(graphOf(['a', 'b']).walk(visit)).rejects.toThrow('a failed');
  });

  // The order is a, b, c, d: one at a time, `c` would fail before `d` was reached.
  it('still visits what the order meets before a failure, and throws its failure', async () => {
    const { visit, log } = visitor({ a: { ms: 20 }, c: { fails: true }, d: { fails: true } });
    const graph = graphOf(
      ['a', 'b', 'c', 'd'],
      [
        ['a', 'c'],
        ['b', 'd'],
      ]
    );

    expect(graph.topologicalSort().flat()).toEqual(['a', 'b', 'c', 'd']);
    await expect(graph.walk(visit)).rejects.toThrow('c failed');
    expect(log).toContain('start c');
  });

  it('fails where a visit throws before it returns, once the others it started end', async () => {
    const { visit, log } = visitor({ b: { ms: 10 } });

    await expect(graphOf(['a', 'b']).walk((id) => (id === 'a' ? throwAtOnce() : visit(id)))).rejects.toThrow('at once');
    expect(log).toEqual(['start b', 'end b']);
  });

  it('ends at once with no node', async () => {
    const { visit, log } = visitor();

    await graphOf([]).walk(visit);

    expect(log).toEqual([]);
  });

  it('walks a chain longer than the call stack', async () => {
    const nodes = Array.from({ length: 20_000 }, (_, index) => `n${index}`);
    const edges = nodes.slice(1).map((node, index): [string, string] => [nodes[index], node]);
    const visited: string[] = [];

    await graphOf(nodes, edges).walk((id) => {
      visited.push(id);
    });

    expect(visited).toEqual(nodes);
  });
});
