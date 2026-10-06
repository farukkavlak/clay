import { Address, Schema, State, STATE_VERSION, types, UNKNOWN } from '@clay/contracts';
import { parseReference, ResourceReference } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { Instances } from '../../src/Instances';
import { Planned } from '../../src/Planned';
import { ResourceResolver } from '../../src/resolvers/ResourceResolver';
import { UnresolvedReferenceError } from '../../src/resolvers/UnresolvedReferenceError';
import { valueOf } from '../../src/Value';
import { steps } from '../ast';

const ref = (spelled: string) => parseReference(steps(...spelled.split('.'))) as ResourceReference;

describe('ResourceResolver', () => {
  const resolver = new ResourceResolver(new Instances(), new Planned(), new Map());
  const context = Address.root('resource', 'main');

  const mockState: State = {
    version: STATE_VERSION,
    serial: 0,
    resources: {
      'resource.test': {
        resourceType: 'resource',
        name: 'test',
        attributes: {
          id: 'res-123',
          simple: 'value',
          settings: { type: 'a', value: 'b' },
        },
      },
    },
  };

  it('should resolve simple attribute', () => {
    const { value: result } = resolver.resolve(ref('resource.test.simple'), context, mockState);
    expect(result).toEqual(valueOf(types.string, 'value'));
  });

  // No schema names its type, so it is inferred from the data.
  it('should return a map from state as it is, keys named type and value included, as an object', () => {
    const { value: result } = resolver.resolve(ref('resource.test.settings'), context, mockState);
    expect(result).toEqual(valueOf(types.object({ type: types.string, value: types.string }), { type: 'a', value: 'b' }));
  });

  it('reads a value as the type its schema names', () => {
    const schemas = new Map<string, Schema>([['resource', { settings: { type: types.map(types.string) } }]]);
    const { value: result } = new ResourceResolver(new Instances(), new Planned(), schemas).resolve(ref('resource.test.settings'), context, mockState);

    expect(result).toEqual(valueOf(types.map(types.string), { type: 'a', value: 'b' }));
  });

  it('reads the id as it reads any value the resource holds', () => {
    const { value: result } = resolver.resolve(ref('resource.test.id'), context, mockState);
    expect(result.data).toBe('res-123');
  });

  it('should throw if resource not found', () => {
    expect(() => resolver.resolve(ref('resource.missing.id'), context, mockState)).toThrow(/Resource "resource.missing" not found/);
  });

  // State holds every attribute, so an unknown name is refused at plan, where it is written.
  it.each(['missing', 'toString', 'constructor', 'hasOwnProperty'])('refuses %s, which state does not hold', (name) => {
    const position = { file: 'main.clay', line: 3, column: 7 };
    const read = () => resolver.resolve(ref(`resource.test.${name}`), context, mockState, position);

    expect(read).toThrow(expect.objectContaining({ message: `resource has no attribute "${name}"`, position }));
    expect(read).not.toThrow(UnresolvedReferenceError);
  });

  // A schema attribute missing from state was left out.
  it('reads a name its schema has and state does not hold as null, of the type the schema names', () => {
    const named = new ResourceResolver(new Instances(), new Planned(), new Map([['resource', { note: { type: types.string } }]]));

    expect(named.resolve(ref('resource.test.note'), context, mockState).value).toEqual(valueOf(types.string, null));
  });

  // A resource the plan creates or changes is read from the plan, not state.
  describe('an instance the plan will create or change', () => {
    const planned = new Planned();
    planned.set('resource.test', { simple: 'new', later: UNKNOWN, made: UNKNOWN });
    const planning = new ResourceResolver(new Instances(), planned, new Map([['resource', { made: { type: types.list(types.string), computed: true } }]]));

    it('reads what its configuration sets, not what state holds', () => {
      expect(planning.resolve(ref('resource.test.simple'), context, mockState).value.data).toBe('new');
    });

    // It comes back unknown, so the caller can take the remaining steps.
    it.each([
      ['a value its configuration does not know yet', 'resource.test.later', types.dynamic],
      ['a value its provider computes', 'resource.test.made', types.list(types.string)],
    ])('reads %s as not known yet, with the type its schema names', (_, spelled, type) => {
      expect(planning.resolve(ref(spelled), context, mockState).value).toEqual(valueOf(type, UNKNOWN));
    });

    // Nothing sets it, so it reads as null.
    it('reads a name its schema has and nothing sets as null, of the type the schema names', () => {
      const named = new ResourceResolver(new Instances(), planned, new Map([['resource', { note: { type: types.string } }]]));

      expect(named.resolve(ref('resource.test.note'), context, mockState).value).toEqual(valueOf(types.string, null));
    });
  });
});
