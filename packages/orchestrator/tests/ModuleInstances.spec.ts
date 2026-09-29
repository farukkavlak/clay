import { ModuleAddress } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { ModuleInstances } from '../src/ModuleInstances';

describe('ModuleInstances', () => {
  it('has one instance of the root', () => {
    expect(new ModuleInstances().of(ModuleAddress.root)).toEqual([ModuleAddress.root]);
  });

  it('makes the instance of a module in a module under the instance of the module that calls it', () => {
    const modules = new ModuleInstances();

    modules.expand(ModuleAddress.root, 'a');
    modules.expand(ModuleAddress.root.child('a'), 'b');

    expect(modules.of(ModuleAddress.root.child('a').child('b'))).toEqual([ModuleAddress.root.child('a').child('b')]);
  });
});
