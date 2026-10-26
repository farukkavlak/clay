import { describe, expect, it } from 'vitest';

import { Address } from '../src/Address';
import { covers } from '../src/dependency';

describe('a dependency', () => {
  it.each([
    ['every instance of its block', 'null_resource.a', 'null_resource.a[3]'],
    ['the one object of a block with no key', 'null_resource.a', 'null_resource.a'],
    ['an object in the module instance it names', 'module.m["x"].null_resource.a', 'module.m["x"].null_resource.a[0]'],
    ['an object in every instance of a module it names no key of', 'module.m.null_resource.a', 'module.m[1].null_resource.a'],
    ['an object nested under the instance it names', 'module.p[0].module.q.null_resource.a', 'module.p[0].module.q[1].null_resource.a'],
  ])('covers %s', (_, dependency, object) => {
    expect(covers(Address.parse(dependency), Address.parse(object))).toBe(true);
  });

  it.each([
    ['another block', 'null_resource.a', 'null_resource.b[0]'],
    ['another type', 'null_resource.a', 'local_file.a'],
    ['another instance of the module it names', 'module.m["x"].null_resource.a', 'module.m["y"].null_resource.a'],
    ['an object under another instance of a module it names', 'module.p[0].module.q.null_resource.a', 'module.p[1].module.q[0].null_resource.a'],
    ['an object in another module', 'module.m.null_resource.a', 'module.n.null_resource.a'],
    ['an object in a module below it', 'null_resource.a', 'module.m.null_resource.a'],
    ['an object in the root, from a module', 'module.m.null_resource.a', 'null_resource.a'],
  ])('does not cover %s', (_, dependency, object) => {
    expect(covers(Address.parse(dependency), Address.parse(object))).toBe(false);
  });
});
