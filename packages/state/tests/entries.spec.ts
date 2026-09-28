import { Address, emptyState, State } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { moveResource } from '../src/entries';

describe('moving a resource in state', () => {
  it('files it under its new address, and renames what reads from it', () => {
    const state: State = {
      ...emptyState(),
      resources: {
        'local_file.a': { id: '1', resourceType: 'local_file', name: 'a', attributes: {} },
        'local_file.b': { id: '2', resourceType: 'local_file', name: 'b', attributes: {}, dependencies: ['local_file.a'] },
      },
    };

    moveResource(state, Address.parse('local_file.a'), Address.parse('local_file.a[0]'));

    expect(Object.keys(state.resources)).toEqual(['local_file.b', 'local_file.a[0]']);
    expect(state.resources['local_file.a[0]']).toMatchObject({ id: '1', key: 0 });
    expect(state.resources['local_file.b'].dependencies).toEqual(['local_file.a[0]']);
  });

  it('refuses a move from an address state holds nothing under, rather than file an empty entry', () => {
    const state = emptyState();

    expect(() => moveResource(state, Address.parse('local_file.a'), Address.parse('local_file.a[0]'))).toThrow('Cannot move local_file.a: state has no resource there');
    expect(state.resources).toEqual({});
  });
});
