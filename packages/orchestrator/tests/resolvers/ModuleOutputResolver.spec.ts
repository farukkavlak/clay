import { Address } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { ModuleOutputResolver } from '../../src/resolvers/ModuleOutputResolver';
import { ScopeManager } from '../../src/scope/ScopeManager';

describe('ModuleOutputResolver', () => {
  const scopeManager = new ScopeManager();
  const resolver = new ModuleOutputResolver(scopeManager);
  const context = new Address([], 'resource', 'main');

  it('should resolve existing output in module', () => {
    // Setup: defined output in sub-module
    scopeManager.setOutput('module.app', 'ip_address', '10.0.0.1');

    const result = resolver.resolve(['module', 'app', 'ip_address'], context);
    expect(result).toBe('10.0.0.1');
  });

  it('should resolve output in nested module from parent scope', () => {
    // Setup nested scope output
    scopeManager.setOutput('module.parent.module.child', 'value', 42);

    const nestedContext = new Address(['parent'], 'resource', 'main');
    const result = resolver.resolve(['module', 'child', 'value'], nestedContext);
    expect(result).toBe(42);
  });

  it('should throw if path parts are insufficient', () => {
    // missing output name
    expect(() => resolver.resolve(['module', 'app'], context)).toThrow(/must include output name/);
  });

  it('should throw if output is not found', () => {
    expect(() => resolver.resolve(['module', 'missing', 'val'], context)).toThrow(/Output "val" not found/);
  });
});
