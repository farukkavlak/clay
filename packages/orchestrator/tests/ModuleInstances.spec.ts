import { ModuleAddress, types } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { ModuleInstances, ReadIn } from '../src/ModuleInstances';
import { valueOf } from '../src/Value';
import { str } from './ast';

const none = (): undefined => {};

/** What a for_each reads to, handed to the parse the call asks for. */
const read: ReadIn = (_, parse) => parse(valueOf(types.object({ b: types.string, a: types.string }), { b: 'two', a: 'one' }));

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

  // The read is the caller's to make: at plan it may be unknown, at apply it is resolved.
  it('makes an instance for each key the for_each of a call gives, and keeps the value of each', () => {
    const modules = new ModuleInstances();
    const block = { type: 'Module', name: 'web', attributes: {}, forEach: str('x'), position: str('x').position } as const;

    modules.expandCall(ModuleAddress.root, block, read);

    expect(modules.of(ModuleAddress.root.child('web')).map(String)).toEqual(['module.web["a"]', 'module.web["b"]']);
    expect(modules.eachValue(ModuleAddress.root.child('web'), 'b')).toEqual(valueOf(types.string, 'two'));
    expect(modules.eachValue(ModuleAddress.root.child('other'), 'b')).toBeUndefined();
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
