import { Address, ModuleAddress, Resource, State, STATE_VERSION } from '@clay/contracts';
import { Graph } from '@clay/graph';
import { ActionType, PlanAction } from '@clay/planner';
import { describe, expect, it } from 'vitest';

import { ApplyNode, applyGraph } from '../../src/plan/applyGraph';
import { GraphNode } from '../../src/graph/DependencyGraphBuilder';

/** Resource blocks `rec.<name>`, each edge from what is read to what reads it. */
function config(names: string[], reads: [string, string][] = []): Graph<GraphNode> {
  const graph = new Graph<GraphNode>();
  for (const name of names) graph.addNode(`rec.${name}`, { kind: 'resource', module: ModuleAddress.root });
  for (const [read, reader] of reads) graph.addEdge(`rec.${read}`, `rec.${reader}`);

  return graph;
}

const act = (type: ActionType, name: string, more: Partial<PlanAction> = {}): PlanAction => ({ type, resourceType: 'rec', name, ...more });

const held = (name: string, ...reads: string[]): Resource => ({ resourceType: 'rec', name, attributes: {}, dependencies: reads.map((read) => `rec.${read}`) });

function stateOf(resources: Resource[], deposed: Record<string, string[]> = {}): State {
  return {
    version: STATE_VERSION,
    serial: 0,
    resources: Object.fromEntries(resources.map((resource) => [`rec.${resource.name}`, resource])),
    ...(Object.keys(deposed).length > 0 && {
      deposed: Object.fromEntries(Object.entries(deposed).map(([name, reads]) => [`rec.${name}`, [{ attributes: {}, dependencies: reads.map((read) => `rec.${read}`) }]])),
    }),
  };
}

/** An object at `address` that read the blocks `reads` names. */
const object = (address: string, ...reads: string[]): [string, Resource] => [address, { ...Address.parse(address).fields(), attributes: {}, dependencies: reads }];
const holding = (...objects: [string, Resource][]): State => ({ version: STATE_VERSION, serial: 0, resources: Object.fromEntries(objects) });
const going = (address: string): PlanAction => ({ type: 'DELETE', ...Address.parse(address).fields() });

/** The order as layers, where a wait node, which runs nothing, holds nothing back a layer. */
const layers = (graph: Graph<ApplyNode>) =>
  graph
    .topologicalSort((key) => graph.getNode(key)!.kind === 'wait')
    .map((layer) => layer.filter((key) => graph.getNode(key)!.kind !== 'wait').sort())
    .filter((layer) => layer.length > 0);

describe('applyGraph', () => {
  it('leaves a replace that reads nothing going away to its block', () => {
    const graph = applyGraph(config(['a', 'b'], [['a', 'b']]), [act('REPLACE', 'a'), act('UPDATE', 'b')], stateOf([held('a'), held('b', 'a')]));

    expect(layers(graph)).toEqual([['rec.a'], ['rec.b']]);
  });

  it('destroys a replaced reader of a replace apart, before both blocks', () => {
    const graph = applyGraph(config(['a', 'b'], [['a', 'b']]), [act('REPLACE', 'a'), act('REPLACE', 'b', { dependencies: ['rec.a'] })], stateOf([held('a'), held('b', 'a')]));

    expect(layers(graph)).toEqual([['destroy:rec.b'], ['rec.a'], ['rec.b']]);
  });

  it('destroys the old object of a create-first replace after its block and what reads it', () => {
    const graph = applyGraph(
      config(['x', 'y'], [['x', 'y']]),
      [act('REPLACE', 'x', { createBeforeDestroy: true }), act('UPDATE', 'y', { dependencies: ['rec.x'] })],
      stateOf([held('x'), held('y', 'x')])
    );

    expect(layers(graph)).toEqual([['rec.x'], ['rec.y'], ['destroy:rec.x (deposed)']]);
    expect(graph.getNode('destroy:rec.x (deposed)')).toMatchObject({ kind: 'destroy', action: { type: 'DELETE', deposed: true, name: 'x' } });
  });

  it('destroys the old object of a create-first replace before a replace it read only in state', () => {
    const graph = applyGraph(config(['a', 'x']), [act('REPLACE', 'a'), act('REPLACE', 'x', { createBeforeDestroy: true })], stateOf([held('a'), held('x', 'a')]));

    expect(layers(graph)).toEqual([['rec.x'], ['destroy:rec.x (deposed)'], ['rec.a']]);
  });

  it('makes what stays and reads a create-first replace wait, though its old object goes before a replace', () => {
    const graph = applyGraph(
      config(['a', 'x', 'y'], [['x', 'y']]),
      [act('REPLACE', 'a'), act('REPLACE', 'x', { createBeforeDestroy: true }), act('UPDATE', 'y', { dependencies: ['rec.x'] })],
      stateOf([held('a'), held('x', 'a'), held('y', 'x')])
    );

    expect(layers(graph)).toEqual([['rec.x'], ['rec.y'], ['destroy:rec.x (deposed)'], ['rec.a']]);
  });

  it.each(['CREATE', 'REPLACE'] as const)('makes no new object wait for the old object of a create-first replace it reads, by %s', (type) => {
    const graph = applyGraph(
      config(
        ['a', 'x', 'r'],
        [
          ['a', 'r'],
          ['x', 'r'],
        ]
      ),
      [act('REPLACE', 'a'), act('REPLACE', 'x', { createBeforeDestroy: true }), act(type, 'r', { dependencies: ['rec.a', 'rec.x'] })],
      stateOf([held('a'), held('x', 'a'), held('r')])
    );

    expect(layers(graph)).toEqual([['rec.x'], ['destroy:rec.x (deposed)'], ['rec.a'], ['rec.r']]);
  });

  it('destroys what a create-first replace leaves after its block, where an older deposed object is planned first', () => {
    const graph = applyGraph(config(['x']), [act('DELETE', 'x', { deposed: true }), act('REPLACE', 'x', { createBeforeDestroy: true })], stateOf([held('x')], { x: [] }));

    expect(layers(graph)).toEqual([['rec.x'], ['destroy:rec.x (deposed)']]);
  });

  it('runs the block of a replace destroyed apart after its destroy', () => {
    const graph = applyGraph(config(['a', 'b']), [act('REPLACE', 'a'), act('REPLACE', 'b')], stateOf([held('a'), held('b', 'a')]));

    expect(layers(graph)).toEqual([['destroy:rec.b'], ['rec.a', 'rec.b']]);
  });

  it('refuses an order that waits for itself, naming each step', () => {
    const graph = config(
      ['a', 'x', 'r'],
      [
        ['a', 'r'],
        ['x', 'r'],
      ]
    );
    const actions = [act('REPLACE', 'a'), act('REPLACE', 'x', { createBeforeDestroy: true }), act('UPDATE', 'r', { dependencies: ['rec.a', 'rec.x'] })];
    const state = stateOf([held('a'), held('x', 'a'), held('r', 'a', 'x')]);

    expect(() => applyGraph(graph, actions, state)).toThrow('No order applies this plan: rec.a waits for destroying the old rec.x, which waits for rec.r, which waits for rec.a');
  });

  it('names a replace destroyed apart in a refused order', () => {
    const graph = config(
      ['a', 'b', 'x', 'k'],
      [
        ['b', 'k'],
        ['x', 'k'],
      ]
    );
    const actions = [act('REPLACE', 'a'), act('REPLACE', 'b'), act('REPLACE', 'x', { createBeforeDestroy: true }), act('UPDATE', 'k', { dependencies: ['rec.b', 'rec.x'] })];
    const state = stateOf([held('a'), held('b', 'a'), held('x', 'b'), held('k', 'b', 'x')]);

    expect(() => applyGraph(graph, actions, state)).toThrow(
      'No order applies this plan: rec.b waits for destroying rec.b, which waits for destroying the old rec.x, which waits for rec.k, which waits for rec.b'
    );
  });

  it('destroys a delete after what stays and read it is updated', () => {
    const graph = applyGraph(config(['b']), [act('DELETE', 'a'), act('UPDATE', 'b')], stateOf([held('a'), held('b', 'a')]));

    expect(layers(graph)).toEqual([['rec.b'], ['destroy:rec.a']]);
  });

  it('destroys a delete that reads a replace before it, after what stays and read the delete is updated', () => {
    const graph = applyGraph(config(['a', 'k']), [act('REPLACE', 'a'), act('DELETE', 'd'), act('UPDATE', 'k')], stateOf([held('a'), held('d', 'a'), held('k', 'd')]));

    expect(layers(graph)).toEqual([['rec.k'], ['destroy:rec.d'], ['rec.a']]);
  });

  it('runs a replace after what stays and read it only in state is updated', () => {
    const graph = applyGraph(config(['a', 'b']), [act('REPLACE', 'a'), act('UPDATE', 'b')], stateOf([held('a'), held('b', 'a')]));

    expect(layers(graph)).toEqual([['rec.b'], ['rec.a']]);
  });

  it('destroys a replace apart after what stays and read it only in state is updated', () => {
    const graph = applyGraph(config(['a', 'b', 'k']), [act('REPLACE', 'a'), act('REPLACE', 'b'), act('UPDATE', 'k')], stateOf([held('a'), held('b', 'a'), held('k', 'b')]));

    expect(layers(graph)).toEqual([['rec.k'], ['destroy:rec.b'], ['rec.a', 'rec.b']]);
  });

  it('adds the waits of a create-first replace first, so another wait gives way to them', () => {
    const graph = applyGraph(
      config(
        ['x', 'y', 'b', 'k', 'j'],
        [
          ['x', 'k'],
          ['y', 'j'],
          ['b', 'j'],
        ]
      ),
      [
        act('REPLACE', 'x'),
        act('REPLACE', 'y'),
        act('REPLACE', 'b', { createBeforeDestroy: true }),
        act('UPDATE', 'k', { dependencies: ['rec.x'] }),
        act('UPDATE', 'j', { dependencies: ['rec.y', 'rec.b'] }),
      ],
      stateOf([held('x'), held('y'), held('b', 'x'), held('k', 'x', 'y'), held('j', 'y', 'b')])
    );

    expect(layers(graph)).toEqual([['rec.b', 'rec.y'], ['rec.j'], ['destroy:rec.b (deposed)'], ['rec.x'], ['rec.k']]);
  });

  it('destroys a delete without waiting for what stays and read it, where the wait closes a loop through the configuration', () => {
    const graph = applyGraph(
      config(['a', 'k'], [['a', 'k']]),
      [act('REPLACE', 'a'), act('DELETE', 'd'), act('UPDATE', 'k', { dependencies: ['rec.a'] })],
      stateOf([held('a'), held('d', 'a'), held('k', 'd')])
    );

    expect(layers(graph)).toEqual([['destroy:rec.d'], ['rec.a'], ['rec.k']]);
  });

  it('runs a delete nothing orders as soon as it can', () => {
    const graph = applyGraph(config(['a', 'b'], [['a', 'b']]), [act('DELETE', 'c'), act('UPDATE', 'a'), act('UPDATE', 'b')], stateOf([held('a'), held('b', 'a'), held('c')]));

    expect(layers(graph)).toEqual([['destroy:rec.c', 'rec.a'], ['rec.b']]);
  });

  it('destroys what reads an address before the objects it left', () => {
    const graph = applyGraph(config([]), [act('DELETE', 'b', { deposed: true }), act('DELETE', 'c')], stateOf([held('c', 'b')], { b: [] }));

    expect(layers(graph)).toEqual([['destroy:rec.c'], ['destroy:rec.b (deposed)']]);
  });

  it('drops a read that closes a loop among objects left at different times', () => {
    const graph = applyGraph(config([]), [act('DELETE', 'a', { deposed: true }), act('DELETE', 'b', { deposed: true })], stateOf([], { a: ['b'], b: ['a'] }));

    expect(layers(graph)).toEqual([['destroy:rec.a (deposed)'], ['destroy:rec.b (deposed)']]);
  });

  it('drops a read of an object of its own block', () => {
    const graph = applyGraph(config([]), [act('DELETE', 'a', { deposed: true }), act('DELETE', 'a')], stateOf([held('a', 'a')], { a: ['a'] }));

    expect(layers(graph)).toEqual([['destroy:rec.a (deposed)'], ['destroy:rec.a']]);
  });

  it('orders a ladder of 200 deletes that each read the two before', () => {
    const names = Array.from({ length: 200 }, (_, index) => `r${index}`);
    const resources = names.map((name, index) => held(name, ...names.slice(Math.max(0, index - 2), index)));

    const graph = applyGraph(
      config([]),
      names.map((name) => act('DELETE', name)),
      stateOf(resources)
    );

    expect(layers(graph).map(([key]) => key)).toEqual(names.map((name) => `destroy:rec.${name}`).reverse());
  });

  describe('with a dependency on a block', () => {
    it('destroys every instance of a reader before every instance of the block it read', () => {
      const state = holding(object('rec.a[0]'), object('rec.a[1]'), object('rec.b[0]', 'rec.a'), object('rec.b[1]', 'rec.a'));

      const graph = applyGraph(
        new Graph<GraphNode>(),
        ['rec.a[0]', 'rec.a[1]', 'rec.b[0]', 'rec.b[1]'].map((address) => going(address)),
        state
      );

      expect(layers(graph)).toEqual([
        ['destroy:rec.b[0]', 'destroy:rec.b[1]'],
        ['destroy:rec.a[0]', 'destroy:rec.a[1]'],
      ]);
    });

    it('passes every reader of a block through one wait node', () => {
      const state = holding(object('rec.a[0]'), object('rec.a[1]'), object('rec.b[0]', 'rec.a'), object('rec.b[1]', 'rec.a'));

      const graph = applyGraph(
        new Graph<GraphNode>(),
        ['rec.a[0]', 'rec.a[1]', 'rec.b[0]', 'rec.b[1]'].map((address) => going(address)),
        state
      );

      expect([graph.dependentsOf('destroy:rec.b[0]'), graph.dependentsOf('destroy:rec.b[1]')]).toEqual([['wait:rec.a'], ['wait:rec.a']]);
      expect(graph.dependentsOf('wait:rec.a').sort()).toEqual(['destroy:rec.a[0]', 'destroy:rec.a[1]']);
    });

    it('waits only for the objects in the module instance it names', () => {
      const read = 'module.p[0].module.q[0].rec.a';
      const other = 'module.p[1].module.q[0].rec.a';
      const state = holding(object(read), object(other), object('module.p[0].rec.r', 'module.p[0].module.q.rec.a'));

      const graph = applyGraph(
        new Graph<GraphNode>(),
        [read, other, 'module.p[0].rec.r'].map((address) => going(address)),
        state
      );

      expect(layers(graph)).toEqual([['destroy:module.p[0].rec.r', `destroy:${other}`], [`destroy:${read}`]]);
    });

    it('makes what stays wait only for the objects in the module instance it names', () => {
      const graph = new Graph<GraphNode>();
      graph.addNode('module.p.rec.r', { kind: 'resource', module: ModuleAddress.root.child('p') });
      const other = 'module.p[1].module.q[0].rec.a';
      const state = holding(object(other), object('module.p[0].rec.r', 'module.p[0].module.q.rec.a'));

      const reader = { ...act('NO_OP', 'r'), ...Address.parse('module.p[0].rec.r').fields(), dependencies: ['module.p[0].module.q.rec.a'] };
      const applied = applyGraph(graph, [going(other), reader], state);

      expect(layers(applied)).toEqual([[`destroy:${other}`, 'module.p.rec.r']]);
    });

    it('updates what stays and reads the block before an instance of it is destroyed', () => {
      const state = holding(object('rec.a[0]'), object('rec.a[1]'), object('rec.b', 'rec.a'));

      const graph = applyGraph(config(['a', 'b'], [['a', 'b']]), [going('rec.a[1]'), act('NO_OP', 'b', { dependencies: ['rec.a'] })], state);

      expect(layers(graph)).toEqual([['rec.a'], ['rec.b'], ['destroy:rec.a[1]']]);
    });
  });
});
