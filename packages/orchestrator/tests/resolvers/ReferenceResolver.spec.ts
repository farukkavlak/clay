import { Address, ExactNumber, ModuleAddress, State, STATE_VERSION, types, UNKNOWN } from '@clay/contracts';
import { AttributeValue, CONFIG_FILE, ConfigError, Lexer, OutputBlock, Parser, TemplatePart } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { Instances } from '../../src/Instances';
import { ModuleInstances } from '../../src/ModuleInstances';
import { Planned } from '../../src/Planned';
import { ReferenceResolver } from '../../src/resolvers/ReferenceResolver';
import { UnresolvedReferenceError } from '../../src/resolvers/UnresolvedReferenceError';
import { ScopeManager } from '../../src/scope/ScopeManager';
import { Value, valueOf } from '../../src/Value';
import { ref, steps, str } from '../ast';

const position = { file: 'main.clay', line: 1, column: 1 };
const num = (text: string): AttributeValue => ({ type: 'Number', value: ExactNumber.parse(text), position });
const list = (...value: AttributeValue[]): AttributeValue => ({ type: 'List', value, position });
const map = (value: Record<string, AttributeValue>): AttributeValue => ({ type: 'Map', value, position });
const template = (...value: TemplatePart[]): AttributeValue => ({ type: 'Template', value, position });
const reference = (...parts: (string | number)[]) => ({ type: 'Reference' as const, value: steps(...parts), position });

const inInstance = (module: ModuleAddress) => new Address(module, 'resource', 'main');
const context = Address.root('resource', 'main');

const state: State = {
  version: STATE_VERSION,
  serial: 0,
  resources: { 'resource.test': { resourceType: 'resource', name: 'test', attributes: { id: 'res-123', val: 'resolved' } } },
};

const resolverWith = (scopes = new ScopeManager(), planned = new Planned(), dataSources = new Map<string, Record<string, Value>>()) =>
  new ReferenceResolver(scopes, dataSources, new Map(), new Map(), new Instances(), new ModuleInstances(), planned);

/** A template reading a resource not in state, so only the apply knows it. */
const readLater = () => resolverWith().resolveValue(template('id: ', reference('resource', 'later', 'id')), state, context);

/** Parsed as an output's value, starting at column 22. */
const written = (value: string) => (new Parser(new Lexer(`output "o" { value = ${value} }`, CONFIG_FILE).tokenize()).parse()[0] as OutputBlock).value;
const atColumn = (column: number) => ({ file: CONFIG_FILE, line: 1, column });
const planning = () => {
  const planned = new Planned();
  planned.begin();
  return planned;
};
const readWith = (value: string, sources = new Map<string, Record<string, Value>>(), planned = new Planned()) =>
  resolverWith(new ScopeManager(), planned, sources).resolveValue(written(value), state, context);
const read = (value: string) => readWith(value);
const source = (value: Value) => new Map([['data:src.s', { v: value }]]);
const n = (text: string) => ExactNumber.parse(text);

describe('ReferenceResolver', () => {
  it.each([
    ['a string', str('simple'), valueOf(types.string, 'simple')],
    ['a number', num('42'), valueOf(types.number, ExactNumber.parse('42'))],
    ['a boolean', { type: 'Boolean', value: true, position } as AttributeValue, valueOf(types.bool, true)],
    ['null, of no type yet', { type: 'Null', position } as AttributeValue, valueOf(types.dynamic, null)],
  ])('reads %s with its type', (_, node, value) => {
    expect(resolverWith().resolveValue(node, state, context)).toEqual(value);
  });

  // Its items may have different types, unlike a list's.
  it('reads a list as a tuple, each item with its own type', () => {
    expect(resolverWith().resolveValue(list(str('a'), num('1')), state, context)).toEqual(valueOf(types.tuple([types.string, types.number]), ['a', ExactNumber.parse('1')]));
  });

  it('reads a map as an object, each value with its own type', () => {
    expect(resolverWith().resolveValue(map({ a: str('x'), b: list() }), state, context)).toEqual(valueOf(types.object({ a: types.string, b: types.tuple([]) }), { a: 'x', b: [] }));
  });

  it('reads a reference to a resource', () => {
    expect(resolverWith().resolveValue(ref('resource', 'test', 'val'), state, context).data).toBe('resolved');
  });

  it('joins a template into text', () => {
    const scopes = new ScopeManager();
    scopes.setVariable('', 'my_var', { value: str('var_value'), context: ModuleAddress.root, block: 'variable "my_var"' });

    expect(resolverWith(scopes).resolveValue(template('Var: ', reference('var', 'my_var'), ', Res: ', reference('resource', 'test', 'val')), state, context)).toEqual(
      valueOf(types.string, 'Var: var_value, Res: resolved')
    );
  });

  it('gives a template of one reference as the value itself, type and all', () => {
    const scopes = new ScopeManager();
    scopes.setVariable('', 'n', { value: num('8'), context: ModuleAddress.root, block: 'variable "n"' });

    expect(resolverWith(scopes).resolveValue(template(reference('var', 'n')), state, context)).toEqual(valueOf(types.number, ExactNumber.parse('8')));
  });

  // The parser already extracted every interpolation, so what remains is text.
  it('leaves a string that spells an interpolation as text', () => {
    expect(resolverWith().resolveValue(str('Value is ${resource.test.val}'), state, context).data).toBe('Value is ${resource.test.val}');
  });

  it.each([
    ['a tuple', list(str('a')), 'var.x is a tuple and cannot be joined into a string'],
    ['an object', map({ a: str('x') }), 'var.x is an object and cannot be joined into a string'],
    ['null', { type: 'Null', position } as AttributeValue, 'var.x is null and cannot be joined into a string'],
  ])('refuses to join %s into text', (_, value, message) => {
    const scopes = new ScopeManager();
    scopes.setVariable('', 'x', { value, context: ModuleAddress.root, block: 'variable "x"' });

    expect(() => resolverWith(scopes).resolveValue(template('a ', reference('var', 'x')), state, context)).toThrow(new ConfigError(message, position));
  });

  // State may hold data outside the schema, so the error names the resource.
  it('refuses a value in state that its schema does not hold, naming the resource', () => {
    const schemas = new Map([['resource', { val: { type: types.number } }]]);
    const resolver = new ReferenceResolver(new ScopeManager(), new Map(), schemas, new Map(), new Instances(), new ModuleInstances(), new Planned());

    expect(() => resolver.resolveValue(reference('resource', 'test', 'val'), state, context)).toThrow(
      new ConfigError('resource.test holds what its schema does not: val is a string, where its type is a number', position)
    );
  });

  // for_each is read before anything in an instance, so a missing value is an engine fault, not a configuration error.
  it('refuses each.value in an instance its for_each gave no value', () => {
    const instance = new Address(ModuleAddress.root, 'resource', 'main', 'k');

    expect(() => resolverWith().resolveValue(reference('each', 'value'), state, instance)).toThrow('each.value of "k" was read before its for_each');
  });

  // A provider may return null where its schema names a string, which has no text to join.
  it('refuses to join a null of a type that joins into text', () => {
    const sources = new Map([['data:src.s', { v: valueOf(types.string, null) }]]);
    const read = () => resolverWith(new ScopeManager(), new Planned(), sources).resolveValue(template('a ', reference('data', 'src', 's', 'v')), state, context);

    expect(read).toThrow(new ConfigError('data.src.s.v is null and cannot be joined into a string', position));
  });

  // Surrounding text makes it a string, whatever the reference resolves to.
  it('leaves a template that reads a value not known yet to the apply, as a string', () => {
    expect(readLater).toThrow(UnresolvedReferenceError);
    expect(readLater).toThrow(expect.objectContaining({ type: types.string }));
  });

  it('says why a for cannot be read by its collection, outside a plan', () => {
    expect(() => read('[for v in resource.later.ids : v]')).toThrow(
      new UnresolvedReferenceError('Invalid resource reference "resource.later.ids": Resource "resource.later" not found in state')
    );
  });

  it('says why a template is not known yet by the first part that is not', () => {
    expect(() => read('"${resource.later.id}-${resource.other.id}"')).toThrow(
      new UnresolvedReferenceError('Invalid resource reference "resource.later.id": Resource "resource.later" not found in state', types.string)
    );
  });

  it('reads every part of a template while one is not known yet, so a mistake after it is found', () => {
    expect(() => readWith('"${resource.later.id}-${tolist([1, true])}"', new Map(), planning())).toThrow(
      new ConfigError('tolist cannot join a number and a boolean into one type', atColumn(53))
    );
  });

  // While planning, an unknown item stands alone with its future type.
  it('reads an item not known yet in a list as unknown, of the type it will have', () => {
    const planned = new Planned();
    planned.begin();

    expect(resolverWith(new ScopeManager(), planned).resolveValue(list(str('a'), template('x', reference('resource', 'later', 'id'))), state, context)).toEqual(
      valueOf(types.tuple([types.string, types.string]), ['a', UNKNOWN])
    );
  });

  describe('a for expression', () => {
    it('reads the body once for each item of a tuple, with its index as the key', () => {
      expect(read('[for i, s in ["a", "b"] : "${i}-${s}"]')).toEqual(valueOf(types.tuple([types.string, types.string]), ['0-a', '1-b']));
    });

    it('gives each item the type its body has', () => {
      expect(read('[for i, s in ["a", 1] : s]')).toEqual(valueOf(types.tuple([types.string, types.number]), ['a', n('1')]));
    });

    it('gives an index as a number', () => {
      expect(read('[for i, s in ["a"] : i]')).toEqual(valueOf(types.tuple([types.number]), [n('0')]));
    });

    it('reads a list of a type, each item of that type', () => {
      expect(readWith('[for s in data.src.s.v : s]', source(valueOf(types.list(types.bool), [true, false])))).toEqual(
        valueOf(types.tuple([types.bool, types.bool]), [true, false])
      );
    });

    it('gives a member of a set as its key and its value', () => {
      expect(readWith('[for k, v in data.src.s.v : "${k}${v}"]', source(valueOf(types.set(types.string), ['a', 'b'])))).toEqual(
        valueOf(types.tuple([types.string, types.string]), ['aa', 'bb'])
      );
    });

    it('reads an object by its keys in order, however they were written', () => {
      expect(read('[for k, v in { b = 1, "1" = 2, a = 3 } : "${k}=${v}"]').data).toEqual(['1=2', 'a=3', 'b=1']);
    });

    it('reads a map by its keys, each value of the type the map holds', () => {
      expect(readWith('[for v in data.src.s.v : v]', source(valueOf(types.map(types.string), { y: '2', x: '1' })))).toEqual(
        valueOf(types.tuple([types.string, types.string]), ['1', '2'])
      );
    });

    it('reads the steps into an item', () => {
      expect(read('[for o in [{ p = ["x", "y"] }] : o.p[1]]').data).toEqual(['y']);
    });

    it('reads a for inside the body of another, with the names of both', () => {
      expect(read('[for a in [["x", "y"], ["z"]] : [for b in a : "${b}${length(a)}"]]').data).toEqual([['x2', 'y2'], ['z1']]);
    });

    it.each([
      ['a list', '[for s in ["a"] : [s]]', valueOf(types.tuple([types.tuple([types.string])]), [['a']])],
      ['a map', '[for s in ["a"] : { k = s }]', valueOf(types.tuple([types.object({ k: types.string })]), [{ k: 'a' }])],
      ['one interpolation alone, with its type', '[for s in [1] : "${s}"]', valueOf(types.tuple([types.number]), [n('1')])],
    ])('reads a name the for gives inside %s in its body', (_, value, expected) => {
      expect(read(value)).toEqual(expected);
    });

    it('gives an empty tuple for an empty collection', () => {
      expect(read('[for s in [] : s]')).toEqual(valueOf(types.tuple([]), []));
    });

    it('refuses a step an item does not have, where the step is written', () => {
      expect(() => read('[for o in [{ p = "x" }] : o.q]')).toThrow(new ConfigError('o has no key "q"', atColumn(48)));
    });

    it('refuses to join an item that has no text, naming it as written', () => {
      expect(() => read('[for s in [["a"]] : "x${s}"]')).toThrow(new ConfigError('s is a tuple and cannot be joined into a string', atColumn(46)));
    });

    it.each([
      ['null', 'null', 'null'],
      ['a string', '"ab"', 'a string'],
      ['a number', '1', 'a number'],
      ['a boolean', 'true', 'a boolean'],
    ])('refuses %s as the collection, where it is written', (_, collection, described) => {
      expect(() => read(`[for s in ${collection} : s]`)).toThrow(new ConfigError(`A for goes over a list, a tuple, a set, a map or an object, not ${described}`, atColumn(32)));
    });

    it('refuses a null of a type it could go over', () => {
      expect(() => readWith('[for s in data.src.s.v : s]', source(valueOf(types.list(types.string), null)))).toThrow(
        new ConfigError('A for goes over a list, a tuple, a set, a map or an object, not null', atColumn(32))
      );
    });

    it('leaves the whole for to the apply while neither its collection nor its type is known', () => {
      expect(() => readWith('[for s in resource.later.ids : s]', new Map(), planning())).toThrow(UnresolvedReferenceError);
    });

    it('refuses a collection not known yet whose type it cannot go over, while planning', () => {
      expect(() => readWith('[for s in data.src.s.v : s]', source(valueOf(types.string, UNKNOWN)), planning())).toThrow(
        new ConfigError('A for goes over a list, a tuple, a set, a map or an object, not a string', atColumn(32))
      );
    });

    it('reads an item not known yet as unknown on its own while planning', () => {
      expect(readWith('[for s in ["a", resource.later.id] : "x-${s}"]', new Map(), planning())).toEqual(valueOf(types.tuple([types.string, types.string]), ['x-a', UNKNOWN]));
    });

    // A for makes a tuple whatever the collection's type.
    it('leaves the whole for to the apply while its list is not known, with no type for what it gives', () => {
      expect(() => readWith('[for s in data.src.s.v : s]', source(valueOf(types.list(types.string), UNKNOWN)), planning())).toThrow(
        expect.objectContaining({ name: 'UnresolvedReferenceError', type: types.dynamic })
      );
    });

    // The unknown member may sort before the others and shift every item.
    it('leaves the whole for to the apply while a member of its set is not known', () => {
      expect(() => readWith('[for s in data.src.s.v : s]', source(valueOf(types.set(types.string), ['a', UNKNOWN])), planning())).toThrow(
        expect.objectContaining({ message: 'The set a for goes over has a member known only after apply, so it has no order yet', type: types.dynamic })
      );
    });
  });

  describe('a for expression that makes an object', () => {
    const keyNotKnown = expect.objectContaining({ message: 'A key in a for is known only after apply, so what the for gives is not known yet', type: types.dynamic });

    it('gives each item its key, with the value its body comes to', () => {
      expect(read('{for k, v in { a = "x", b = "y" } : k => "${v}${k}"}')).toEqual(valueOf(types.object({ a: types.string, b: types.string }), { a: 'xa', b: 'yb' }));
    });

    it('gives each value the type it has', () => {
      expect(read('{for v in ["s", 1] : "${v}" => v}')).toEqual(valueOf(types.object({ s: types.string, 1: types.number }), { s: 's', 1: n('1') }));
    });

    it('takes a number or a boolean key as its text', () => {
      expect(read('{for v in [1, true] : v => v}')).toEqual(valueOf(types.object({ 1: types.number, true: types.bool }), { 1: n('1'), true: true }));
    });

    it('groups the values of one key in a tuple, in the order of the items', () => {
      expect(read('{for i, v in ["a", "b", "a"] : v => i...}')).toEqual(
        valueOf(types.object({ a: types.tuple([types.number, types.number]), b: types.tuple([types.number]) }), { a: [n('0'), n('2')], b: [n('1')] })
      );
    });

    it('gives an empty object for an empty collection', () => {
      expect(read('{for v in [] : v => v}')).toEqual(valueOf(types.object({}), {}));
    });

    it('reads a for that makes a list in its value, with the names of both', () => {
      expect(read('{for k, v in { a = ["x", "y"] } : k => [for s in v : "${k}${s}"]}').data).toEqual({ a: ['ax', 'ay'] });
    });

    it('refuses a key two items give, where the key is written', () => {
      expect(() => read('{for v in ["a", "a"] : v => v}')).toThrow(new ConfigError('Two items give the key "a"; write "..." after the value to group them', atColumn(45)));
    });

    it.each([
      ['a tuple', '[v]'],
      ['null', 'null'],
      ['an object', '{ k = v }'],
    ])('refuses %s as a key, where the key is written', (described, key) => {
      expect(() => read(`{for v in ["a"] : ${key} => v}`)).toThrow(new ConfigError(`A key in a for is a string, a number or a boolean, not ${described}`, atColumn(40)));
    });

    it('refuses __proto__ as a key, which would set the prototype', () => {
      expect(() => read('{for v in ["__proto__"] : v => v}')).toThrow(new ConfigError('__proto__ cannot be a name', atColumn(48)));
    });

    it('reads a value not known yet as unknown on its own while planning', () => {
      expect(readWith('{for v in ["a"] : v => "x-${resource.later.id}"}', new Map(), planning())).toEqual(valueOf(types.object({ a: types.string }), { a: UNKNOWN }));
    });

    it('leaves the whole for to the apply while a key the apply makes is not known', () => {
      expect(() => readWith('{for v in ["a"] : resource.later.id => v}', new Map(), planning())).toThrow(keyNotKnown);
    });

    it('says why a key cannot be read, outside a plan', () => {
      expect(() => read('{for v in ["a"] : resource.later.id => v}')).toThrow('Resource "resource.later" not found in state');
    });

    it('leaves the whole for to the apply while a key is not known, grouped too', () => {
      expect(() => readWith('{for v in ["a", resource.later.id] : v => 1...}', new Map(), planning())).toThrow(keyNotKnown);
    });

    it('leaves the whole for to the apply while an item read as a key is not known', () => {
      expect(() => readWith('{for v in ["a", resource.later.id] : v => 1}', new Map(), planning())).toThrow(keyNotKnown);
    });

    it.each([
      ['a key of a type no key can have', '{for v in [resource.later.id, ["a"]] : v => 1}', 'A key in a for is a string, a number or a boolean, not a tuple', 61],
      ['a key two items give', '{for v in ["a", resource.later.id, "a"] : v => 1}', 'Two items give the key "a"; write "..." after the value to group them', 64],
      ['a mistake in a value', '{for v in [resource.later.id, "a"] : v => [for s in v : s]}', 'A for goes over a list, a tuple, a set, a map or an object, not a string', 74],
    ])('refuses %s in a later item while an earlier key is not known yet', (_, value, message, column) => {
      expect(() => readWith(value, new Map(), planning())).toThrow(new ConfigError(message, atColumn(column)));
    });

    it('refuses a key not known yet whose type no key can have, while planning', () => {
      expect(() => readWith('{for v in ["a"] : data.src.s.v => v}', source(valueOf(types.list(types.string), UNKNOWN)), planning())).toThrow(
        new ConfigError('A key in a for is a string, a number or a boolean, not a list', atColumn(40))
      );
    });
  });

  // Every module instance shares its variables but reads its own resources and outputs.
  describe('in an instance of a module', () => {
    it('reads the instance of a resource in that instance of the module', () => {
      const instances = new Instances();
      instances.declare('module.app.resource.dep', 'count');
      const held: State = {
        version: STATE_VERSION,
        serial: 0,
        resources: { 'module.app[0].resource.dep[1]': { resourceType: 'resource', name: 'dep', attributes: { id: 'one' } } },
      };

      const read = new ReferenceResolver(new ScopeManager(), new Map(), new Map(), new Map(), instances, new ModuleInstances(), new Planned()).resolveValue(
        reference('resource', 'dep', 1, 'id'),
        held,
        inInstance(ModuleAddress.root.child('app', 0))
      );

      expect(read.data).toBe('one');
    });

    it('reads an input in the instance of the calling module it sits in', () => {
      const scopes = new ScopeManager();
      scopes.setVariable('module.a.module.b', 'x', { value: reference('module', 'c', 'out'), context: ModuleAddress.root.child('a'), block: 'variable "x"' });
      scopes.setOutput('module.a[1].module.c', 'out', valueOf(types.string, 'from a[1]'));
      scopes.setOutput('module.a.module.c', 'out', valueOf(types.string, 'from a'));

      const read = resolverWith(scopes).resolveValue(reference('var', 'x'), state, inInstance(ModuleAddress.root.child('a', 1).child('b', 0)));

      expect(read.data).toBe('from a[1]');
    });

    it('reads the data source of its own module instance', () => {
      const sources = new Map([
        ['module.app[0].data:src.s', { v: valueOf(types.string, 'from app[0]') }],
        ['module.app[1].data:src.s', { v: valueOf(types.string, 'from app[1]') }],
      ]);

      const read = resolverWith(new ScopeManager(), new Planned(), sources).resolveValue(reference('data', 'src', 's', 'v'), state, inInstance(ModuleAddress.root.child('app', 1)));

      expect(read.data).toBe('from app[1]');
    });
  });
});
