import { Address, ModuleAddress } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { blockKey, callKey, enclosing } from '../src/keys';

describe('keys', () => {
  it.each([
    ['at the root', ModuleAddress.root.child('app'), 'module:app'],
    ['in a module', ModuleAddress.root.child('app').child('db'), 'module.app.module:db'],
  ])('keys the call of a module %s in the module that calls it', (_, module, key) => {
    expect(callKey(module)).toBe(key);
  });

  it('keys a resource by its block as the configuration writes it, with no key of an instance or of a module', () => {
    expect(blockKey(new Address(ModuleAddress.root.child('app', 0).child('db', 'x'), 'local_file', 'a', 2))).toBe('module.app.module.db.local_file.a');
  });

  it.each([
    ['the root', ModuleAddress.root, ''],
    ['the module that calls it', ModuleAddress.root.child('a'), 'module.a[1]'],
    ['the module itself', ModuleAddress.root.child('a').child('b'), 'module.a[1].module.b[0]'],
  ])('finds the instance of %s that an instance sits in', (_, module, instance) => {
    expect(enclosing(ModuleAddress.root.child('a', 1).child('b', 0), module).toString()).toBe(instance);
  });
});
