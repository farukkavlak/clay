import { Address, State } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { ResourceResolver } from '../../src/resolvers/ResourceResolver';
import { UnresolvedReferenceError } from '../../src/resolvers/UnresolvedReferenceError';

describe('ResourceResolver', () => {
  const resolver = new ResourceResolver();
  const context = new Address([], 'resource', 'main');

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
    const result = resolver.resolve(['resource', 'test', 'simple'], context, mockState);
    expect(result).toBe('value');
  });

  it('should return a map from state as it is, keys named type and value included', () => {
    const result = resolver.resolve(['resource', 'test', 'settings'], context, mockState);
    expect(result).toEqual({ type: 'a', value: 'b' });
  });

  it('should resolve resource id when attribute is "id"', () => {
    const result = resolver.resolve(['resource', 'test', 'id'], context, mockState);
    expect(result).toBe('res-123');
  });

  it('should throw if path too short', () => {
    expect(() => resolver.resolve(['resource', 'test'], context, mockState)).toThrow(/must include attribute/);
  });

  it('should throw if resource not found', () => {
    expect(() => resolver.resolve(['resource', 'missing', 'id'], context, mockState)).toThrow(/Resource "resource.missing" not found/);
  });

  it.each(['toString', 'constructor', 'hasOwnProperty'])('should throw if the attribute is only inherited, like %s', (name) => {
    expect(() => resolver.resolve(['resource', 'test', name], context, mockState)).toThrow(UnresolvedReferenceError);
    expect(() => resolver.resolve(['resource', 'test', name], context, mockState)).toThrow(`Attribute "${name}" not found`);
  });

  it('should throw if attribute not found', () => {
    expect(() => resolver.resolve(['resource', 'test', 'missing'], context, mockState)).toThrow(/Attribute "missing" not found/);
  });
});
