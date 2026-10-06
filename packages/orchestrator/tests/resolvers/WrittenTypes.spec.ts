import { ModuleAddress, Schema, types } from '@clay/contracts';
import { parseReference, ResourceReference } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { Instances } from '../../src/Instances';
import { WrittenTypes } from '../../src/resolvers/WrittenTypes';
import { ScopeManager } from '../../src/scope/ScopeManager';
import { steps } from '../ast';

const position = { file: 'main.clay', line: 1, column: 1 };

const schemas = new Map<string, Schema>([['random_string', { id: { type: types.string, computed: true }, length: { type: types.number, required: true } }]]);

const typeOf = (instances: Instances, ...path: (string | number)[]) =>
  new WrittenTypes(new ScopeManager(), schemas, instances).typeOf(parseReference(steps('random_string', 's', ...path)) as ResourceReference, ModuleAddress.root, position);

describe('the type a resource reference will have, read before any instance exists', () => {
  it('is an object of every attribute and its type where the reference names no attribute', () => {
    expect(typeOf(new Instances())).toEqual({ type: types.object({ id: types.string, length: types.number }), path: [] });
  });

  it('is the same object for one instance named by its index, with the steps after it left to take', () => {
    const instances = new Instances();
    instances.declare('random_string.s', 'count');

    expect(typeOf(instances, 0)).toEqual({ type: types.object({ id: types.string, length: types.number }), path: [] });
    expect(typeOf(instances, 0, 'length', 'x')).toEqual({ type: types.number, path: steps('x') });
  });

  it('refuses an attribute the schema does not have', () => {
    expect(() => typeOf(new Instances(), 'nope')).toThrow('random_string has no attribute "nope"');
  });
});
