import { Address, EVERY_ITEM, ModuleAddress, Schema, Type, types } from '@clay/contracts';
import { DataReference, ModuleOutputReference, parseReference, ResourceReference, spell } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { Instances } from '../../../src/instances/Instances';
import { ModuleInstances } from '../../../src/instances/ModuleInstances';
import { WrittenTypes } from '../../../src/expressions/references/WrittenTypes';
import { ScopeManager } from '../../../src/config/ScopeManager';
import { Versions } from '../../../src/values/Versions';
import { dataBlock, outputBlock, resourceBlock, steps, str } from '../../ast';

const position = { file: 'main.clay', line: 1, column: 1 };

const schemas = new Map<string, Schema>([['random_string', { id: { type: types.string, computed: true }, length: { type: types.number, required: true } }]]);

/** Every block is declared at load, with what it is given. */
const declaring = (type: string, name: string, attributes = {}) => {
  const scopes = new ScopeManager(new Versions());
  const context = Address.root(type, name);
  scopes.declareBlock(context.toString(), { block: resourceBlock(type, name, attributes), context });
  return scopes;
};

const typeOf = (instances: Instances, ...path: (string | number)[]) =>
  new WrittenTypes(declaring('random_string', 's'), schemas, new Map(), instances, new ModuleInstances()).typeOf(
    parseReference(steps('random_string', 's', ...path)) as ResourceReference,
    ModuleAddress.root,
    position
  );

describe('the type a resource reference will have, read before any instance exists', () => {
  it('is an object of every attribute and its type where the reference names no attribute', () => {
    expect(typeOf(new Instances())).toEqual({ type: types.object({ id: types.string, length: types.number }), sensitive: [], from: [], path: [] });
  });

  it('is the same object for one instance named by its index, with the steps after it left to take', () => {
    const instances = new Instances();
    instances.declare('random_string.s', 'count');

    expect(typeOf(instances, 0)).toEqual({ type: types.object({ id: types.string, length: types.number }), sensitive: [], from: [], path: [] });
    expect(typeOf(instances, 0, 'length', 'x')).toEqual({ type: types.number, sensitive: [], from: [], path: steps('x') });
  });

  it.each([
    ['count', types.list(types.object({ id: types.string, length: types.number }))],
    ['for_each', types.map(types.object({ id: types.string, length: types.number }))],
  ] as const)('is every instance of that object, with %s, where the reference names no instance', (repetition, type) => {
    const instances = new Instances();
    instances.declare('random_string.s', repetition);

    expect(typeOf(instances)).toEqual({ type, sensitive: [], from: [], path: [] });
  });

  it('refuses an attribute the schema does not have', () => {
    expect(() => typeOf(new Instances(), 'nope')).toThrow('random_string has no attribute "nope"');
  });
});

describe('the marks a resource reference will have, read before any instance exists', () => {
  const marked = new Map<string, Schema>([['secret_string', { value: { type: types.string, computed: true, sensitive: true }, length: { type: types.number, required: true } }]]);

  const marksOf = (instances: Instances, ...path: (string | number)[]) =>
    new WrittenTypes(declaring('secret_string', 's'), marked, new Map(), instances, new ModuleInstances()).typeOf(
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

  const scopes = new ScopeManager(new Versions());
  scopes.declareBlock('data:secret_file.f', { block: dataBlock('secret_file', 'f'), context: ModuleAddress.root });

  const marksOf = (instances: Instances, ...path: (string | number)[]) =>
    new WrittenTypes(scopes, new Map(), marked, instances, new ModuleInstances()).typeOf(
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

const SIZE = outputBlock('size', str('1'), true);
const NAME = outputBlock('name', str('n'));

const outputOf = (repetition: 'count' | 'for_each' | undefined, ...path: (string | number)[]) => {
  const scopes = new ScopeManager(new Versions());
  scopes.declareOutputs(
    'module.n',
    new Map<string, Type>([
      ['size', types.number],
      ['name', types.string],
    ]),
    new Map([
      ['size', SIZE],
      ['name', NAME],
    ])
  );
  const modules = new ModuleInstances();
  if (repetition) modules.declare(ModuleAddress.root.child('n'), repetition);

  return new WrittenTypes(scopes, new Map(), new Map(), new Instances(), modules).typeOf(
    parseReference(steps('module', 'n', ...path)) as ModuleOutputReference,
    ModuleAddress.root,
    position
  );
};

const outputMarksOf = (repetition: 'count' | 'for_each' | undefined, ...path: (string | number)[]) => outputOf(repetition, ...path).sensitive;

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

describe('the values whose marks a reference takes, read before any instance exists', () => {
  const LENGTH = str('4');
  const block = { context: Address.root('random_string', 's'), declaration: spell(resourceBlock('random_string', 's')), held: expect.any(Function) };

  const sourcesOf = (repetition: 'count' | 'for_each' | undefined, ...path: (string | number)[]) => {
    const instances = new Instances();
    if (repetition) instances.declare('random_string.s', repetition);

    return new WrittenTypes(declaring('random_string', 's', { length: LENGTH }), schemas, new Map(), instances, new ModuleInstances()).typeOf(
      parseReference(steps('random_string', 's', ...path)) as ResourceReference,
      ModuleAddress.root,
      position
    ).from;
  };

  it('is the value a resource is given for the attribute named, and none for one it is not given', () => {
    expect(sourcesOf(undefined, 'length')).toEqual([{ value: LENGTH, ...block, at: [] }]);
    expect(sourcesOf(undefined, 'id')).toEqual([]);
  });

  it('is each value a resource is given, at its attribute, in the whole instance', () => {
    expect(sourcesOf(undefined)).toEqual([{ value: LENGTH, ...block, at: ['length'] }]);
  });

  it('is each value a resource is given, under every instance where the reference names none', () => {
    expect(sourcesOf('count')).toEqual([{ value: LENGTH, ...block, at: [EVERY_ITEM, 'length'] }]);
  });

  it('is the value of the output named', () => {
    expect(outputOf(undefined, 'name').from).toEqual([{ value: NAME.value, context: ModuleAddress.root.child('n'), declaration: spell(NAME), held: expect.any(Function), at: [] }]);
  });

  it('is the value of each output, at its name, in the whole instance and under every instance', () => {
    const call = ModuleAddress.root.child('n');

    expect(outputOf(undefined).from.map(({ at }) => at)).toEqual([['size'], ['name']]);
    expect(outputOf('count').from).toEqual([
      { value: SIZE.value, context: call, declaration: spell(SIZE), held: expect.any(Function), at: [EVERY_ITEM, 'size'] },
      { value: NAME.value, context: call, declaration: spell(NAME), held: expect.any(Function), at: [EVERY_ITEM, 'name'] },
    ]);
  });
});
