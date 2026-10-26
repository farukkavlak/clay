import { Address, emptyState, State } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { forgetDependencies, moveResource } from '../src/entries';

const inM = (key: number) => ({ modulePath: [{ name: 'm', key }], resourceType: 'local_file', name: 'x', attributes: {} });

describe('moving a resource in state', () => {
  it('files it under its new address, where what reads its block still reads it', () => {
    const state: State = {
      ...emptyState(),
      resources: {
        'local_file.a': { resourceType: 'local_file', name: 'a', attributes: { id: '1' } },
        'local_file.b': { resourceType: 'local_file', name: 'b', attributes: {}, dependencies: ['local_file.a'] },
      },
    };

    moveResource(state, Address.parse('local_file.a'), Address.parse('local_file.a[0]'));

    expect(Object.keys(state.resources)).toEqual(['local_file.b', 'local_file.a[0]']);
    expect(state.resources['local_file.a[0]']).toMatchObject({ attributes: { id: '1' }, key: 0 });
    expect(state.resources['local_file.b'].dependencies).toEqual(['local_file.a']);
  });

  it('adds its new block to what read it, beside the old one while that holds other instances', () => {
    const state: State = {
      ...emptyState(),
      resources: {
        'local_file.a[0]': { resourceType: 'local_file', name: 'a', key: 0, attributes: {} },
        'local_file.a[1]': { resourceType: 'local_file', name: 'a', key: 1, attributes: {} },
        'local_file.b': { resourceType: 'local_file', name: 'b', attributes: {}, dependencies: ['local_file.a', 'local_file.x'] },
      },
    };

    moveResource(state, Address.parse('local_file.a[0]'), Address.parse('local_file.c[0]'));

    expect(state.resources['local_file.b'].dependencies).toEqual(['local_file.a', 'local_file.x', 'local_file.c']);
  });

  it('names every instance of the module it moved to, where what read it named every instance it moved from', () => {
    const state: State = {
      ...emptyState(),
      resources: {
        'module.m[0].local_file.x': inM(0),
        'module.m[1].local_file.x': inM(1),
        'local_file.b': { resourceType: 'local_file', name: 'b', attributes: {}, dependencies: ['module.m.local_file.x'] },
      },
    };

    moveResource(state, Address.parse('module.m[0].local_file.x'), Address.parse('module.n[0].local_file.x'));
    moveResource(state, Address.parse('module.m[1].local_file.x'), Address.parse('module.n[1].local_file.x'));

    expect(state.resources['local_file.b'].dependencies).toEqual(['module.n.local_file.x']);
  });

  it('renames the block what read it reads, once the old one holds nothing', () => {
    const state: State = {
      ...emptyState(),
      resources: {
        'local_file.a': { resourceType: 'local_file', name: 'a', attributes: {} },
        'local_file.b': { resourceType: 'local_file', name: 'b', attributes: {}, dependencies: ['local_file.x', 'local_file.a'] },
      },
    };

    moveResource(state, Address.parse('local_file.a'), Address.parse('local_file.c'));

    expect(state.resources['local_file.b'].dependencies).toEqual(['local_file.x', 'local_file.c']);
  });

  it('names the module it moved to as what read it named the one it moved from', () => {
    const state: State = {
      ...emptyState(),
      resources: {
        'module.m[0].local_file.a': { modulePath: [{ name: 'm', key: 0 }], resourceType: 'local_file', name: 'a', attributes: {} },
        'module.m[1].local_file.a': { modulePath: [{ name: 'm', key: 1 }], resourceType: 'local_file', name: 'a', attributes: {} },
        'local_file.b': { resourceType: 'local_file', name: 'b', attributes: {}, dependencies: ['module.m.local_file.a'] },
        'local_file.c': { resourceType: 'local_file', name: 'c', attributes: {}, dependencies: ['module.m[1].local_file.a'] },
        'local_file.d': { resourceType: 'local_file', name: 'd', attributes: {}, dependencies: ['module.m[0].local_file.a'] },
      },
    };

    moveResource(state, Address.parse('module.m[0].local_file.a'), Address.parse('module.n["x"].local_file.a'));

    expect(state.resources['local_file.b'].dependencies).toEqual(['module.m.local_file.a', 'module.n.local_file.a']);
    expect(state.resources['local_file.c'].dependencies).toEqual(['module.m[1].local_file.a']);
    expect(state.resources['local_file.d'].dependencies).toEqual(['module.n["x"].local_file.a']);
  });

  it('moves the deposed objects with it, after any the new address already holds', () => {
    const state: State = {
      ...emptyState(),
      resources: { 'local_file.a': { resourceType: 'local_file', name: 'a', attributes: {} } },
      deposed: { 'local_file.a': [{ attributes: { id: 'new' } }], 'local_file.a[0]': [{ attributes: { id: 'held' } }] },
    };

    moveResource(state, Address.parse('local_file.a'), Address.parse('local_file.a[0]'));

    expect(state.deposed).toEqual({ 'local_file.a[0]': [{ attributes: { id: 'held' } }, { attributes: { id: 'new' } }] });
  });

  it('adds its new block to what deposed objects read', () => {
    const state: State = {
      ...emptyState(),
      resources: { 'local_file.a': { resourceType: 'local_file', name: 'a', attributes: {} } },
      deposed: { 'local_file.b': [{ attributes: { id: 'old' }, dependencies: ['local_file.a'] }] },
    };

    moveResource(state, Address.parse('local_file.a'), Address.parse('local_file.c'));

    expect(state.deposed?.['local_file.b'][0].dependencies).toEqual(['local_file.c']);
  });

  // A plan works on a copy of the map that shares the objects in it.
  it('leaves the deposed objects a copy of the map shares as they were', () => {
    const shared = { attributes: {}, dependencies: ['local_file.a'] };
    const copy: State = {
      ...emptyState(),
      resources: { 'local_file.a': { resourceType: 'local_file', name: 'a', attributes: {} } },
      deposed: { 'local_file.b': [shared] },
    };

    moveResource(copy, Address.parse('local_file.a'), Address.parse('local_file.c'));

    expect(shared.dependencies).toEqual(['local_file.a']);
    expect(copy.deposed?.['local_file.b'][0].dependencies).toEqual(['local_file.c']);
  });

  it('leaves the state with no deposed objects as it was', () => {
    const state: State = { ...emptyState(), resources: { 'local_file.a': { resourceType: 'local_file', name: 'a', attributes: {} } } };

    moveResource(state, Address.parse('local_file.a'), Address.parse('local_file.a[0]'));

    expect(state).not.toHaveProperty('deposed');
  });

  it('refuses a move from an address state holds nothing under, rather than file an empty entry', () => {
    const state = emptyState();

    expect(() => moveResource(state, Address.parse('local_file.a'), Address.parse('local_file.a[0]'))).toThrow('Cannot move local_file.a: state has no resource there');
    expect(state.resources).toEqual({});
  });
});

describe('forgetting what a removed object was read through', () => {
  it('keeps a dependency that covers another object still held', () => {
    const state: State = {
      ...emptyState(),
      resources: {
        'local_file.a[1]': { resourceType: 'local_file', name: 'a', key: 1, attributes: {} },
        'local_file.b': { resourceType: 'local_file', name: 'b', attributes: {}, dependencies: ['local_file.a'] },
      },
      deposed: { 'local_file.c': [{ attributes: {}, dependencies: ['local_file.a'] }] },
    };

    forgetDependencies(state, Address.parse('local_file.a[0]'));

    expect(state.resources['local_file.b'].dependencies).toEqual(['local_file.a']);
    expect(state.deposed?.['local_file.c'][0].dependencies).toEqual(['local_file.a']);
  });

  it('keeps a dependency that covers only a deposed object still held', () => {
    const state: State = {
      ...emptyState(),
      resources: { 'local_file.b': { resourceType: 'local_file', name: 'b', attributes: {}, dependencies: ['local_file.a'] } },
      deposed: { 'local_file.a': [{ attributes: {} }] },
    };

    forgetDependencies(state, Address.parse('local_file.a'));

    expect(state.resources['local_file.b'].dependencies).toEqual(['local_file.a']);
  });
});
