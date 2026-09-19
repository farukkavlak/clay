import { IState } from '@clay/state';
import { describe, expect, it } from 'vitest';

import { Address } from '../../src/Address';
import { ResourceResolver } from '../../src/resolvers/ResourceResolver';
import { ScopeManager } from '../../src/scope/ScopeManager';

describe('ResourceResolver', () => {
  const scopeManager = new ScopeManager();
  const resolver = new ResourceResolver(scopeManager);
  const context = new Address([], 'resource', 'main');

  const mockState: IState = {
    version: 1,
    serial: 0,
    resources: {
      'resource.test': {
        id: 'res-123',
        type: 'Resource',
        resourceType: 'resource',
        name: 'test',
        attributes: {
          simple: 'value',
          wrapped: { type: 'String', value: 'unwrapped' },
        },
      },
      'module.app.resource.db': {
        id: 'db-456',
        type: 'Resource',
        resourceType: 'resource',
        name: 'db',
        attributes: {
          port: 5432,
        },
      },
    },
  };

  it('should resolve simple attribute', () => {
    const result = resolver.resolve(['resource', 'test', 'simple'], context, mockState);
    expect(result).toBe('value');
  });

  it('should resolve wrapped attribute value', () => {
    const result = resolver.resolve(['resource', 'test', 'wrapped'], context, mockState);
    expect(result).toBe('unwrapped');
  });

  it('should resolve resource id when attribute is "id"', () => {
    const result = resolver.resolve(['resource', 'test', 'id'], context, mockState);
    expect(result).toBe('res-123');
  });

  it('should resolve resource in module', () => {
    const result = resolver.resolve(['module', 'app', 'resource', 'db', 'port'], context, mockState);
    expect(result).toBe(5432);
  });

  it('should throw if path too short', () => {
    expect(() => resolver.resolve(['resource', 'test'], context, mockState)).toThrow(/must include attribute/);
  });

  it('should throw if resource not found', () => {
    // module reference parsing but not existing
    expect(() => resolver.resolve(['module', 'missing', 'resource', 'main', 'id'], context, mockState)).toThrow(/Resource "module.missing.resource.main" not found/);

    expect(() => resolver.resolve(['resource', 'missing', 'id'], context, mockState)).toThrow(/Resource "resource.missing" not found/);
  });

  it('should throw if attribute not found', () => {
    expect(() => resolver.resolve(['resource', 'test', 'missing'], context, mockState)).toThrow(/Attribute "missing" not found/);
  });
});
