import { Address, State } from '@clay/contracts';
import { parseReference, ResourceReference } from '@clay/parser';
import { UNKNOWN } from '@clay/planner';
import { describe, expect, it } from 'vitest';

import { Instances } from '../../src/Instances';
import { Planned } from '../../src/Planned';
import { ResourceResolver } from '../../src/resolvers/ResourceResolver';
import { UnresolvedReferenceError } from '../../src/resolvers/UnresolvedReferenceError';

const ref = (spelled: string) => parseReference(spelled.split('.')) as ResourceReference;

describe('ResourceResolver', () => {
  const resolver = new ResourceResolver(new Instances(), new Planned());
  const context = Address.root('resource', 'main');

  const mockState: State = {
    version: 1,
    serial: 0,
    resources: {
      'resource.test': {
        id: 'res-123',
        resourceType: 'resource',
        name: 'test',
        attributes: {
          simple: 'value',
          settings: { type: 'a', value: 'b' },
        },
      },
    },
  };

  it('should resolve simple attribute', () => {
    const { value: result } = resolver.resolve(ref('resource.test.simple'), context, mockState);
    expect(result).toBe('value');
  });

  it('should return a map from state as it is, keys named type and value included', () => {
    const { value: result } = resolver.resolve(ref('resource.test.settings'), context, mockState);
    expect(result).toEqual({ type: 'a', value: 'b' });
  });

  it('should resolve resource id when attribute is "id"', () => {
    const { value: result } = resolver.resolve(ref('resource.test.id'), context, mockState);
    expect(result).toBe('res-123');
  });

  it('should throw if resource not found', () => {
    expect(() => resolver.resolve(ref('resource.missing.id'), context, mockState)).toThrow(/Resource "resource.missing" not found/);
  });

  it.each(['toString', 'constructor', 'hasOwnProperty'])('should throw if the attribute is only inherited, like %s', (name) => {
    expect(() => resolver.resolve(ref(`resource.test.${name}`), context, mockState)).toThrow(UnresolvedReferenceError);
    expect(() => resolver.resolve(ref(`resource.test.${name}`), context, mockState)).toThrow(`Attribute "${name}" not found`);
  });

  it('should throw if attribute not found', () => {
    expect(() => resolver.resolve(ref('resource.test.missing'), context, mockState)).toThrow(/Attribute "missing" not found/);
  });

  // A resource the plan creates or changes is read as the plan knows it, over what state holds.
  describe('an instance the plan will create or change', () => {
    const planned = new Planned();
    planned.set('resource.test', { simple: 'new', later: UNKNOWN });
    const planning = new ResourceResolver(new Instances(), planned);

    it('reads what its configuration sets, not what state holds', () => {
      expect(planning.resolve(ref('resource.test.simple'), context, mockState).value).toBe('new');
    });

    it.each([
      ['its id', 'resource.test.id'],
      ['a value its configuration does not know yet', 'resource.test.later'],
      ['a value its configuration does not set', 'resource.test.settings'],
    ])('leaves %s to the apply', (_, spelled) => {
      expect(() => planning.resolve(ref(spelled), context, mockState)).toThrow(UnresolvedReferenceError);
    });
  });
});
