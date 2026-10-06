import { Address, ExactNumber, ModuleAddress, types } from '@clay/contracts';
import { ModuleOutputReference, parseReference, Step } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { ModuleInstances } from '../../src/ModuleInstances';
import { ModuleOutputResolver } from '../../src/resolvers/ModuleOutputResolver';
import { ScopeManager } from '../../src/scope/ScopeManager';
import { Value, valueOf } from '../../src/Value';
import { steps } from '../ast';

const record = (url: string, port: unknown) => ({ url, port });

const ref = (...parts: (string | number | Step)[]) => parseReference(steps(...parts)) as ModuleOutputReference;

describe('ModuleOutputResolver', () => {
  const scopeManager = new ScopeManager();
  const modules = new ModuleInstances();
  modules.declare(ModuleAddress.root.child('web'), 'count');
  modules.declare(ModuleAddress.root.child('db'), 'for_each');
  const resolver = new ModuleOutputResolver(scopeManager, modules);
  const context = Address.root('resource', 'main');

  it('should resolve existing output in module', () => {
    scopeManager.setOutput('module.app', 'ip_address', valueOf(types.string, '10.0.0.1'));

    expect(resolver.resolve(ref('module', 'app', 'ip_address'), context)).toEqual({ value: valueOf(types.string, '10.0.0.1'), path: [] });
  });

  it('should resolve output in nested module from parent scope', () => {
    scopeManager.setOutput('module.parent.module.child', 'value', valueOf(types.number, ExactNumber.parse('42')));

    const nestedContext = new Address(ModuleAddress.root.child('parent'), 'resource', 'main');
    expect(resolver.resolve(ref('module', 'child', 'value'), nestedContext).value.data).toEqual(ExactNumber.parse('42'));
  });

  it('reads the output of the instance an index names, and gives back the steps into it', () => {
    const tags = valueOf(types.object({ env: types.string }), { env: 'b' });
    scopeManager.setOutput('module.web[1]', 'tags', tags);

    expect(resolver.resolve(ref('module', 'web', 1, 'tags', 'env'), context)).toEqual({ value: tags, path: steps('env') });
  });

  it('reads the output of the instance a key names', () => {
    scopeManager.setOutput('module.db["eu"]', 'url', valueOf(types.string, 'eu-url'));

    expect(resolver.resolve(ref('module', 'db', { key: 'eu' }, 'url'), context).value.data).toBe('eu-url');
  });

  it.each([
    ['no key on a module called with for_each', ref('module', 'db', 'url'), 'module.db has for_each, so name one of it by key, as in module.db["key"]'],
    ['a key after a dot on a module called with for_each', ref('module', 'db', 'eu', 'url'), 'module.db has for_each, so name one of it by key, as in module.db["key"]'],
    ['an index on a module called with for_each', ref('module', 'db', 0, 'url'), 'module.db has for_each, so name one of it by key, as in module.db["key"]'],
    ['an index on a module called without count', ref('module', 'app', 0, 'ip_address'), 'module.app has no count, so it takes no index'],
    ['no index on a module called with count', ref('module', 'web', 'tags'), 'module.web has count, so name one of it by index, as in module.web[0]'],
    ['an index where the output goes', ref('module', 'web', 0, 1), 'Reference "module.web[0][1]" has an index where it needs a name'],
    ['an output that is no name', ref('module', 'app', { key: 'a b' }), 'Reference "module.app["a b"]" has "a b" where it needs a name'],
  ])('refuses %s', (_, reference, message) => {
    expect(() => resolver.resolve(reference, context)).toThrow(message);
  });

  it('should throw if output is not found', () => {
    expect(() => resolver.resolve(ref('module', 'missing', 'val'), context)).toThrow(/Output "val" not found/);
  });

  describe('a whole module', () => {
    const scopes = new ScopeManager();
    const calls = new ModuleInstances();
    const whole = new ModuleOutputResolver(scopes, calls);
    const site = (scope: string, url: string, port: Value) => {
      scopes.setOutput(scope, 'url', valueOf(types.string, url));
      scopes.setOutput(scope, 'port', port);
    };
    const number = (text: string) => valueOf(types.number, ExactNumber.parse(text));

    const outputs = new Map([
      ['url', types.dynamic],
      ['port', types.dynamic],
    ]);
    scopes.declareOutputs('module.app', outputs);
    scopes.declareOutputs('module.web', outputs);
    scopes.declareOutputs('module.db', outputs);
    calls.declare(ModuleAddress.root.child('web'), 'count');
    calls.declare(ModuleAddress.root.child('db'), 'for_each');
    calls.expand(ModuleAddress.root, 'web', () => [0, 1]);
    calls.expand(ModuleAddress.root, 'db', () => ['eu', 'us']);
    site('module.app', 'app-url', number('80'));
    site('module.web[0]', 'web-0', number('80'));
    site('module.web[1]', 'web-1', valueOf(types.string, '8080'));
    site('module.db["eu"]', 'eu-url', number('5432'));
    site('module.db["us"]', 'us-url', valueOf(types.tuple([types.string]), ['5432']));

    it('reads one instance as an object of every output it declares', () => {
      expect(whole.resolve(ref('module', 'app'), context).value.data).toEqual(record('app-url', ExactNumber.parse('80')));
      expect(whole.resolve(ref('module', 'web', 0), context).value).toEqual(
        valueOf(types.object({ url: types.string, port: types.number }), record('web-0', ExactNumber.parse('80')))
      );
    });

    // A string can hold a number, so the two instances take one type, as tolist gives them.
    it('reads every instance under count as a list, each output in one type', () => {
      expect(whole.resolve(ref('module', 'web'), context)).toEqual({
        value: valueOf(types.list(types.object({ url: types.string, port: types.string })), [record('web-0', '80'), record('web-1', '8080')]),
        path: [],
      });
    });

    it('refuses every instance under for_each where an output takes no one type, naming the output', () => {
      expect(() => whole.resolve(ref('module', 'db'), context)).toThrow('module.db cannot join a number and a tuple into one type, at .port in each item');
    });
  });
});
