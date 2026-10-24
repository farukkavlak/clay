import { EVERY_ITEM, ModuleAddress, Schema, Type, types } from '@clay/contracts';
import { DataReference, ModuleOutputReference, parseReference, ResourceReference } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { Instances } from '../../src/Instances';
import { ModuleInstances } from '../../src/ModuleInstances';
import { WrittenTypes } from '../../src/resolvers/WrittenTypes';
import { ScopeManager } from '../../src/scope/ScopeManager';
import { steps } from '../ast';

const position = { file: 'main.clay', line: 1, column: 1 };

const schemas = new Map<string, Schema>([['random_string', { id: { type: types.string, computed: true }, length: { type: types.number, required: true } }]]);

const typeOf = (instances: Instances, ...path: (string | number)[]) =>
  new WrittenTypes(new ScopeManager(), schemas, new Map(), instances, new ModuleInstances()).typeOf(
    parseReference(steps('random_string', 's', ...path)) as ResourceReference,
    ModuleAddress.root,
    position
  );

describe('the type a resource reference will have, read before any instance exists', () => {
  it('is an object of every attribute and its type where the reference names no attribute', () => {
    expect(typeOf(new Instances())).toEqual({ type: types.object({ id: types.string, length: types.number }), sensitive: [], path: [] });
  });

  it('is the same object for one instance named by its index, with the steps after it left to take', () => {
    const instances = new Instances();
    instances.declare('random_string.s', 'count');

    expect(typeOf(instances, 0)).toEqual({ type: types.object({ id: types.string, length: types.number }), sensitive: [], path: [] });
    expect(typeOf(instances, 0, 'length', 'x')).toEqual({ type: types.number, sensitive: [], path: steps('x') });
  });

  it.each([
    ['count', types.list(types.object({ id: types.string, length: types.number }))],
    ['for_each', types.map(types.object({ id: types.string, length: types.number }))],
  ] as const)('is every instance of that object, with %s, where the reference names no instance', (repetition, type) => {
    const instances = new Instances();
    instances.declare('random_string.s', repetition);

    expect(typeOf(instances)).toEqual({ type, sensitive: [], path: [] });
  });

  it('refuses an attribute the schema does not have', () => {
    expect(() => typeOf(new Instances(), 'nope')).toThrow('random_string has no attribute "nope"');
  });
});

describe('the marks a resource reference will have, read before any instance exists', () => {
  const marked = new Map<string, Schema>([['secret_string', { value: { type: types.string, computed: true, sensitive: true }, length: { type: types.number, required: true } }]]);

  const marksOf = (instances: Instances, ...path: (string | number)[]) =>
    new WrittenTypes(new ScopeManager(), marked, new Map(), instances, new ModuleInstances()).typeOf(
      parseReference(steps('secret_string', 's', ...path)) as ResourceReference,
      ModuleAddress.root,
      position
    ).sensitive;

  it('is the whole attribute the schema marks', () => {
    expect(marksOf(new Instances(), 'value')).toEqual([[]]);
    expect(marksOf(new Instances(), 'length')).toEqual([]);
  });

  it('is the attribute the schema marks, in the whole instance', () => {
    expect(marksOf(new Instances())).toEqual([['value']]);
  });

  it.each(['count', 'for_each'] as const)('is the attribute the schema marks under every instance, with %s, where the reference names none', (repetition) => {
    const instances = new Instances();
    instances.declare('secret_string.s', repetition);

    expect(marksOf(instances)).toEqual([[EVERY_ITEM, 'value']]);
  });
});

describe('the marks a data source reference will have, read before any instance exists', () => {
  const marked = new Map<string, Schema>([['secret_file', { value: { type: types.string, computed: true, sensitive: true }, path: { type: types.string, required: true } }]]);

  const marksOf = (instances: Instances, ...path: (string | number)[]) =>
    new WrittenTypes(new ScopeManager(), new Map(), marked, instances, new ModuleInstances()).typeOf(
      parseReference(steps('data', 'secret_file', 'f', ...path)) as DataReference,
      ModuleAddress.root,
      position
    ).sensitive;

  it('is the whole attribute the schema marks', () => {
    expect(marksOf(new Instances(), 'value')).toEqual([[]]);
    expect(marksOf(new Instances(), 'path')).toEqual([]);
  });

  it('is the attribute the schema marks, in the whole instance', () => {
    expect(marksOf(new Instances())).toEqual([['value']]);
  });

  it.each(['count', 'for_each'] as const)('is the attribute the schema marks under every instance, with %s, where the reference names none', (repetition) => {
    const instances = new Instances();
    instances.declare('data:secret_file.f', repetition);

    expect(marksOf(instances)).toEqual([[EVERY_ITEM, 'value']]);
  });
});

const outputMarksOf = (repetition: 'count' | 'for_each' | undefined, ...path: (string | number)[]) => {
  const scopes = new ScopeManager();
  scopes.declareOutputs(
    'module.n',
    new Map<string, Type>([
      ['size', types.number],
      ['name', types.string],
    ]),
    new Set(['size'])
  );
  const modules = new ModuleInstances();
  if (repetition) modules.declare(ModuleAddress.root.child('n'), repetition);

  return new WrittenTypes(scopes, new Map(), new Map(), new Instances(), modules).typeOf(
    parseReference(steps('module', 'n', ...path)) as ModuleOutputReference,
    ModuleAddress.root,
    position
  ).sensitive;
};

describe('the marks a module output reference will have, read before any instance exists', () => {
  it('is the whole output written sensitive', () => {
    expect(outputMarksOf(undefined, 'size')).toEqual([[]]);
    expect(outputMarksOf(undefined, 'name')).toEqual([]);
  });

  it('is the output written sensitive, in the whole instance', () => {
    expect(outputMarksOf(undefined)).toEqual([['size']]);
  });

  it.each(['count', 'for_each'] as const)('is the output written sensitive under every instance, with %s, where the reference names none', (repetition) => {
    expect(outputMarksOf(repetition)).toEqual([[EVERY_ITEM, 'size']]);
  });
});
