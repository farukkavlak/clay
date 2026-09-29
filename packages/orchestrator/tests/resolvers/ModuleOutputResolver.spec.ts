import { Address, ModuleAddress } from '@clay/contracts';
import { ModuleOutputReference, parseReference, Step } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { ModuleInstances } from '../../src/ModuleInstances';
import { ModuleOutputResolver } from '../../src/resolvers/ModuleOutputResolver';
import { ScopeManager } from '../../src/scope/ScopeManager';

const ref = (...parts: Step[]) => parseReference(parts) as ModuleOutputReference;

describe('ModuleOutputResolver', () => {
  const scopeManager = new ScopeManager();
  const modules = new ModuleInstances();
  modules.declare(ModuleAddress.root.child('web'), 'count');
  const resolver = new ModuleOutputResolver(scopeManager, modules);
  const context = Address.root('resource', 'main');

  it('should resolve existing output in module', () => {
    scopeManager.setOutput('module.app', 'ip_address', '10.0.0.1');

    expect(resolver.resolve(ref('module', 'app', 'ip_address'), context)).toEqual({ value: '10.0.0.1', path: [] });
  });

  it('should resolve output in nested module from parent scope', () => {
    scopeManager.setOutput('module.parent.module.child', 'value', 42);

    const nestedContext = new Address(ModuleAddress.root.child('parent'), 'resource', 'main');
    expect(resolver.resolve(ref('module', 'child', 'value'), nestedContext).value).toBe(42);
  });

  it('reads the output of the instance an index names, and gives back the steps into it', () => {
    scopeManager.setOutput('module.web[1]', 'tags', { env: 'b' });

    expect(resolver.resolve(ref('module', 'web', 1, 'tags', 'env'), context)).toEqual({ value: { env: 'b' }, path: ['env'] });
  });

  it.each([
    ['an index on a module called without count', ref('module', 'app', 0, 'ip_address'), 'module.app has no count, so it takes no index'],
    ['no index on a module called with count', ref('module', 'web', 'tags'), 'module.web has count, so name one of it by index, as in module.web[0]'],
    ['an index and no output', ref('module', 'web', 0), 'Module output reference must include output name: module.web[0]'],
    ['an index where the output goes', ref('module', 'web', 0, 1), 'Reference "module.web[0][1]" has an index where it needs a name'],
    ['an output that is no name', ref('module', 'app', 'a b'), 'Reference "module.app["a b"]" has "a b" where it needs a name'],
  ])('refuses %s', (_, reference, message) => {
    expect(() => resolver.resolve(reference, context)).toThrow(message);
  });

  it('should throw if output is not found', () => {
    expect(() => resolver.resolve(ref('module', 'missing', 'val'), context)).toThrow(/Output "val" not found/);
  });
});
