import { describe, expect, it } from 'vitest';

import { growth, LINEAR } from '../../../tests/growth';
import { Graph } from '../src/Graph';

/** Milliseconds listing what each node of a chain of `size` depends on takes. */
function chainDependencies(size: number): number {
  const graph = new Graph<string>();
  for (let node = 0; node < size; node++) graph.addNode(`n${node}`, '');
  for (let node = 1; node < size; node++) graph.addEdge(`n${node - 1}`, `n${node}`);

  const started = performance.now();
  const dependencies = Array.from({ length: size }, (_, node) => graph.dependenciesOf(`n${node}`));
  const took = performance.now() - started;

  expect(dependencies[size - 1]).toEqual([`n${size - 2}`]);
  return took;
}

describe('Graph', () => {
  it('lists what each node of a long chain depends on in time that grows with it', async () => {
    expect(await growth(5000, chainDependencies)).toBeLessThan(LINEAR);
  });
});
