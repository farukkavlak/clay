import { describe, expect, it } from 'vitest';

import { ScopeManager } from '../../src/config/ScopeManager';
import { Versions } from '../../src/values/Versions';

const scopes = () => new ScopeManager(new Versions());

describe('ScopeManager', () => {
  it.each([
    ['a variable', () => scopes().declaredVariable('', 'v'), 'variable "v" is not declared in the root module, which is a bug'],
    ['a local', () => scopes().declaredLocal('', 'l'), 'local "l" is not declared in the root module, which is a bug'],
    ['a local in a module', () => scopes().declaredLocal('module.a', 'l'), 'local "l" is not declared in module.a, which is a bug'],
    ['a block', () => scopes().declaredBlock('random_string.s'), 'random_string.s is not declared, which is a bug'],
    ['a module call', () => scopes().declaredCall('module:a'), 'module:a is not declared, which is a bug'],
    ['the directory of a module', () => scopes().getDirectory('module.a'), 'the directory of module.a is not loaded, which is a bug'],
  ])('says it is a bug where %s is asked for before it is declared', (_, ask, message) => {
    expect(ask).toThrow(new Error(message));
  });
});
