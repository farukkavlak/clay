import { Address, emptyState, State } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { mapDependencies, moveResource } from '../src/entries';

describe('moving a resource in state', () => {
  it('files it under its new address, and renames what reads from it', () => {
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
    expect(state.resources['local_file.b'].dependencies).toEqual(['local_file.a[0]']);
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

  it('renames what deposed objects read from it', () => {
    const state: State = {
      ...emptyState(),
      resources: { 'local_file.a': { resourceType: 'local_file', name: 'a', attributes: {} } },
      deposed: { 'local_file.b': [{ attributes: { id: 'old' }, dependencies: ['local_file.a'] }] },
    };

    moveResource(state, Address.parse('local_file.a'), Address.parse('local_file.a[0]'));

    expect(state.deposed?.['local_file.b'][0].dependencies).toEqual(['local_file.a[0]']);
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

describe('rewriting dependencies in state', () => {
  it('drops a dependency from deposed objects too', () => {
    const state: State = { ...emptyState(), deposed: { 'local_file.b': [{ attributes: {}, dependencies: ['local_file.a', 'local_file.c'] }] } };

    mapDependencies(state, (dependency) => (dependency === 'local_file.a' ? undefined : dependency));

    expect(state.deposed?.['local_file.b'][0].dependencies).toEqual(['local_file.c']);
  });

  // A plan works on a copy of the map that shares the objects in it.
  it('leaves the deposed objects a copy of the map shares as they were', () => {
    const shared = { attributes: {}, dependencies: ['local_file.a'] };
    const copy: State = { ...emptyState(), deposed: { 'local_file.b': [shared] } };

    mapDependencies(copy, () => 'local_file.z');

    expect(shared.dependencies).toEqual(['local_file.a']);
  });
});
