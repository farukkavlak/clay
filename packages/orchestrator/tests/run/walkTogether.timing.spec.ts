import { Graph } from '@clay/graph';
import { describe, expect, it } from 'vitest';

import { growth, LINEAR } from '../../../../tests/growth';
import { walkTogether } from '../../src/run/walkTogether';

async function* reach(id: string): AsyncGenerator<string, []> {
  yield `reached ${id}`;
  return [];
}

async function* step(): AsyncGenerator<string, boolean> {
  yield 'stepped';
  return true;
}

/** How long a walk takes over `size` nodes that depend on nothing and run no steps. */
async function wide(size: number): Promise<number> {
  const graph = new Graph<string>();
  for (let index = 0; index < size; index++) graph.addNode(`n${index}`, `n${index}`);

  const started = performance.now();
  for await (const _ of walkTogether(graph.topologicalSort().flat(), graph, reach, 10, () => false));
  return performance.now() - started;
}

/** How long a walk takes over one node that runs `size` steps. */
async function long(size: number): Promise<number> {
  const graph = new Graph<string>();
  graph.addNode('n', 'n');
  const steps = Array.from({ length: size }, () => step);
  const reachSteps = async function* (id: string) {
    yield `reached ${id}`;
    return steps;
  };

  const started = performance.now();
  for await (const _ of walkTogether(['n'], graph, reachSteps, 10, () => false));
  return performance.now() - started;
}

describe('walking a graph together', () => {
  it('walks nodes ready together in time that grows with them', async () => {
    expect(await growth(8000, wide)).toBeLessThan(LINEAR);
  });

  it('runs the steps of a node in time that grows with them', async () => {
    expect(await growth(8000, long)).toBeLessThan(LINEAR);
  });
});
