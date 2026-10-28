import { Address, ModuleAddress, STATE_VERSION } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { describe, expect, it } from 'vitest';

import { growth, LINEAR } from '../../../../tests/growth';
import { GraphNode } from '../../src/graph/DependencyGraphBuilder';
import { applyGraph } from '../../src/plan/applyGraph';

/** How long ordering a replace of each of `size` instances of one block takes. */
function replaced(size: number): number {
  const config = new Graph<GraphNode>();
  config.addNode('rec.a', { kind: 'resource', module: ModuleAddress.root });
  const addresses = Array.from({ length: size }, (_, index) => Address.parse(`rec.a[${index}]`));
  const actions = addresses.map((address) => ({ type: 'REPLACE' as const, ...address.fields() }));
  const resources = Object.fromEntries(addresses.map((address) => [address.toString(), { ...address.fields(), attributes: {}, dependencies: [] }]));

  const started = performance.now();
  applyGraph(config, actions, { version: STATE_VERSION, serial: 0, resources });
  return performance.now() - started;
}

describe('applyGraph', () => {
  it('orders replaces in time that grows with them', async () => {
    expect(await growth(8000, replaced)).toBeLessThan(LINEAR);
  });
});
