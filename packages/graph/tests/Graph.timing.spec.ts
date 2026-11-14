import { describe, expect, it } from 'vitest';

import { growth, LINEAR } from '../../../tests/growth';
import { Graph } from '../src/Graph';

/** Listed this many times over one graph, so the measure is long enough that noise does not decide the ratio; `repeated` would build the graph again each time. */
const LISTINGS = 20;

/** Milliseconds listing what each node of a chain of `size` depends on takes, `LISTINGS` times. */
function chainDependencies(size: number): number {
  const graph = new Graph<string>();
  for (let node = 0; node < size; node++) graph.addNode(`n${node}`, '');
  for (let node = 1; node < size; node++) graph.addEdge(`n${node - 1}`, `n${node}`);

  // Counted, not kept, so the heap holds no more at the larger size than the graph.
  let listed = 0;
  const started = performance.now();
  for (let listing = 0; listing < LISTINGS; listing++) for (let node = 0; node < size; node++) listed += graph.dependenciesOf(`n${node}`).length;
  const took = performance.now() - started;

  expect(listed).toBe(LISTINGS * (size - 1));
  expect(graph.dependenciesOf(`n${size - 1}`)).toEqual([`n${size - 2}`]);
  return took;
}

describe('Graph', () => {
  it('lists what each node of a long chain depends on in time that grows with it', async () => {
    expect(await growth(5000, chainDependencies)).toBeLessThan(LINEAR);
  });
});
