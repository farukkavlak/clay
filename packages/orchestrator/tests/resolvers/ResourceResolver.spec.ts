import { Address, State, STATE_VERSION, UNKNOWN } from '@clay/contracts';
import { parseReference, ResourceReference } from '@clay/parser';
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
    expect(result).toBe('value');
  });

  it('should return a map from state as it is, keys named type and value included', () => {
    const { value: result } = resolver.resolve(ref('resource.test.settings'), context, mockState);
    expect(result).toEqual({ type: 'a', value: 'b' });
  });

  it('reads the id as it reads any value the resource holds', () => {
    const { value: result } = resolver.resolve(ref('resource.test.id'), context, mockState);
    expect(result).toBe('res-123');
  });

  it('should throw if resource not found', () => {
    expect(() => resolver.resolve(ref('resource.missing.id'), context, mockState)).toThrow(/Resource "resource.missing" not found/);
  });

  // State holds all the resource has, so a plan refuses the name where it is written rather than leaving it to the apply.
  it.each(['missing', 'toString', 'constructor', 'hasOwnProperty'])('refuses %s, which state does not hold', (name) => {
    const position = { file: 'main.clay', line: 3, column: 7 };
    const read = () => resolver.resolve(ref(`resource.test.${name}`), context, mockState, position);

    expect(read).toThrow(expect.objectContaining({ message: `Invalid resource reference "resource.test.${name}": Attribute "${name}" not found on resource`, position }));
    expect(read).not.toThrow(UnresolvedReferenceError);
  });

  // A resource the plan creates or changes is read as the plan knows it, over what state holds.
  describe('an instance the plan will create or change', () => {
    const planned = new Planned();
    planned.set('resource.test', { simple: 'new', later: UNKNOWN, made: UNKNOWN });
    const planning = new ResourceResolver(new Instances(), planned);

    it('reads what its configuration sets, not what state holds', () => {
      expect(planning.resolve(ref('resource.test.simple'), context, mockState).value).toBe('new');
    });

    it.each([
      ['a value its configuration does not know yet', 'resource.test.later'],
      ['a value its provider computes', 'resource.test.made'],
    ])('leaves %s to the apply', (_, spelled) => {
      expect(() => planning.resolve(ref(spelled), context, mockState)).toThrow(UnresolvedReferenceError);
    });

    // State holds settings, but the plan will make the instance anew from its configuration.
    it.each(['settings', 'toString'])('refuses %s, which neither its configuration sets nor its provider computes', (name) => {
      const position = { file: 'main.clay', line: 3, column: 7 };

      expect(() => planning.resolve(ref(`resource.test.${name}`), context, mockState, position)).toThrow(
        expect.objectContaining({ message: `"resource.test.${name}" will never be known: the configuration does not set ${name} and resource does not compute it`, position })
      );
    });
  });
});
