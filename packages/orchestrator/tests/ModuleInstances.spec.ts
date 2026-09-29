import { ModuleAddress } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { ModuleInstances } from '../src/ModuleInstances';

const none = (): undefined => {};

describe('ModuleInstances', () => {
  it('has one instance of the root', () => {
    expect(new ModuleInstances().of(ModuleAddress.root)).toEqual([ModuleAddress.root]);
  });

  it('makes the instance of a module in a module under the instance of the module that calls it', () => {
    const modules = new ModuleInstances();

    modules.expand(ModuleAddress.root, 'a', none);
    modules.expand(ModuleAddress.root.child('a'), 'b', none);

    expect(modules.of(ModuleAddress.root.child('a').child('b'))).toEqual([ModuleAddress.root.child('a').child('b')]);
  });

  it('makes an instance for each key a call gives, in each instance of the module that calls it', () => {
    const modules = new ModuleInstances();
    const a = ModuleAddress.root.child('a');

    modules.expand(ModuleAddress.root, 'a', () => [0, 1]);
    modules.expand(a, 'b', (caller) => (caller.path[0].key === 0 ? [0] : [0, 1]));

    expect(modules.of(a.child('b')).map(String)).toEqual(['module.a[0].module.b[0]', 'module.a[1].module.b[0]', 'module.a[1].module.b[1]']);
    expect(modules.keysOf(ModuleAddress.root.child('a', 1).child('b'))).toEqual([0, 1]);
    expect(modules.keysOf(ModuleAddress.root.child('a', 1).child('c'))).toBeUndefined();
  });

  it('says which modules are called with count until it is cleared', () => {
    const modules = new ModuleInstances();
    modules.declare(ModuleAddress.root.child('a'), 'count');

    expect(modules.repetitionOf(ModuleAddress.root.child('a'))).toBe('count');
    expect(modules.repetitionOf(ModuleAddress.root.child('b'))).toBeUndefined();

    modules.clear();
    expect(modules.repetitionOf(ModuleAddress.root.child('a'))).toBeUndefined();
  });
});
