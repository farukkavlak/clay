import { ExactNumber, Type, types, UNKNOWN } from '@clay/contracts';
import { AttributeValue, TypeDefaults } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { SchemaMismatch } from '../src/conformValues';
import { checkDefaults, declaredAs } from '../src/declared';
import { inferred, Value, valueOf } from '../src/Value';

/** As the configuration writes it: a list is a tuple and a map an object. */
const written = (data: unknown): Value => valueOf(inferred(data), data);

const n = (text: string) => ExactNumber.parse(text);

const mismatchOf = (value: Value, type: Type): SchemaMismatch => {
  try {
    declaredAs('variable', 'v', value, type);
  } catch (error) {
    if (error instanceof SchemaMismatch) return error;

    throw error;
  }

  throw new Error('Expected the variable to refuse the value');
};

describe('a value held to the type its variable names', () => {
  it.each([
    ['a tuple as a set, each member once and in order', written(['b', 'a', 'a']), types.set(types.string), ['a', 'b']],
    ['a number as a string', written(n('1')), types.string, '1'],
    ['a string that spells a number as a number', written('5'), types.number, n('5')],
    ['each item of a mixed tuple as a string', written([n('1'), true, 'x']), types.list(types.string), ['1', 'true', 'x']],
    ['an object as an object of the attribute types named', written({ a: n('1') }), types.object({ a: types.string }), { a: '1' }],
    ['null, as a null of the type', written(null), types.number, null],
  ])('takes %s', (_, value, type, data) => {
    expect(declaredAs('variable', 'v', value, type)).toEqual({ type, data });
  });

  it.each([
    ['any', written([n('1'), 'x']), types.dynamic, written([n('1'), 'x'])],
    ['list(any), its items joined into one type', written([n('1'), 'x']), types.list(types.dynamic), valueOf(types.list(types.string), ['1', 'x'])],
    ['map(any) over an object', written({ a: n('1'), b: 'x' }), types.map(types.dynamic), valueOf(types.map(types.string), { a: '1', b: 'x' })],
    [
      'any as an attribute, which keeps the type found there',
      written({ a: [true], b: 'x' }),
      types.object({ a: types.dynamic, b: types.string }),
      valueOf(types.object({ a: types.tuple([types.bool]), b: types.string }), { a: [true], b: 'x' }),
    ],
    ['any in a tuple, position by position', written([true, '2']), types.tuple([types.dynamic, types.number]), valueOf(types.tuple([types.bool, types.number]), [true, n('2')])],
    ['list(any) with no item', written([]), types.list(types.dynamic), valueOf(types.list(types.dynamic), [])],
  ])('reads %s from the value', (_, value, type, expected) => {
    expect(declaredAs('variable', 'v', value, type)).toEqual(expected);
  });

  it('gives a value not known yet the type named', () => {
    expect(declaredAs('variable', 'v', valueOf(types.dynamic, UNKNOWN), types.list(types.dynamic))).toEqual(valueOf(types.list(types.dynamic), UNKNOWN));
    expect(declaredAs('variable', 'v', valueOf(types.string, UNKNOWN), types.number)).toEqual(valueOf(types.number, UNKNOWN));
  });

  it.each([
    ['a string that spells no number', written('x'), types.number, 'v: "x" is not a number'],
    ['a list where a number goes', written(['a']), types.number, 'v is a tuple, where variable "v" takes a number'],
    ['a value not known yet whose type can never be a number', valueOf(types.list(types.string), UNKNOWN), types.number, 'v is a list, where variable "v" takes a number'],
    ['an attribute the object type does not name', written({ a: 'x', extra: 'y' }), types.object({ a: types.string }), 'variable "v" has no attribute "extra" in v'],
    ['an object without an attribute its type names', written({}), types.object({ a: types.string }), 'variable "v" requires "a" in v'],
    ['a number and a boolean where list(any) joins them', written([n('1'), true]), types.list(types.dynamic), 'variable "v" cannot join a number and a boolean into one type'],
  ])('refuses %s', (_, value, type, message) => {
    expect(mismatchOf(value, type).message).toContain(message);
  });

  it('refuses a name the object type does not have before what a set in it holds, where the type names nothing optional', () => {
    const value = valueOf(types.object({ a: types.set(types.object({ k: types.tuple([types.number]) })), c: types.number }), { a: [{ k: [n('1')] }], c: n('1') });
    const type = types.object({ a: types.set(types.object({ k: types.string })), b: types.number });

    expect(mismatchOf(value, type).message).toBe('variable "v" has no attribute "c" in v');
  });

  it('converts each item on its own where no any asks to join them', () => {
    expect(declaredAs('variable', 'v', written([n('1'), true]), types.list(types.string))).toEqual(valueOf(types.list(types.string), ['1', 'true']));
  });
});

const place = { file: 'main.clay', line: 1, column: 1 };
const constants = new Map<AttributeValue, Value>();

const constant = (data: unknown): AttributeValue => {
  const node: AttributeValue = { type: 'String', value: JSON.stringify(data), position: place };
  constants.set(node, written(data));
  return node;
};

const read = (node: AttributeValue): Value => constants.get(node)!;
const filledAs = (value: Value, type: Type, tree: TypeDefaults = {}) => declaredAs('variable', 'v', value, type, { tree, read });

describe('the optional attributes of an object type', () => {
  const site = types.object({ name: types.string, port: types.number, tag: types.string }, ['port', 'tag']);

  it('gives one left out null where its type names no default', () => {
    expect(declaredAs('variable', 'v', written({ name: 'a' }), site)).toEqual(
      valueOf(types.object({ name: types.string, port: types.number, tag: types.string }), { name: 'a', port: null, tag: null })
    );
  });

  it('gives one left out, or given null, its default as the type of the attribute', () => {
    const tree = { values: { port: constant('80'), tag: constant('t') } };

    expect(filledAs(written({ name: 'a', tag: null }), site, tree).data).toEqual({ name: 'a', port: n('80'), tag: 't' });
  });

  it('keeps a value given, and a null given to an attribute it requires', () => {
    const tree = { values: { port: constant(n('80')), tag: constant('t') } };

    expect(filledAs(written({ name: null, port: n('1'), tag: 'x' }), site, tree).data).toEqual({ name: null, port: n('1'), tag: 'x' });
  });

  it('fills a default in with the defaults inside it', () => {
    const type = types.object({ tls: types.object({ on: types.bool, cert: types.string }, ['on', 'cert']) }, ['tls']);
    const tree = { values: { tls: constant({}) }, within: { tls: { values: { on: constant(true) } } } };

    expect(filledAs(written({}), type, tree).data).toEqual({ tls: { on: true, cert: null } });
  });

  it.each([
    ['each item of a list', types.list(types.object({ k: types.string }, ['k'])), [{}, { k: 'b' }], [{ k: 'z' }, { k: 'b' }]],
    ['each value of a map', types.map(types.object({ k: types.string }, ['k'])), { x: {} }, { x: { k: 'z' } }],
    ['each member of a set, then held once', types.set(types.object({ k: types.string }, ['k'])), [{}, { k: 'z' }], [{ k: 'z' }]],
  ])('fills in %s', (_, type, data, expected) => {
    expect(filledAs(written(data), type, { element: { values: { k: constant('z') } } }).data).toEqual(expected);
  });

  it('fills in a tuple position by position', () => {
    const type = types.tuple([types.object({ k: types.string }, ['k']), types.object({ k: types.string }, ['k'])]);

    expect(filledAs(written([{}, {}]), type, { within: { 1: { values: { k: constant('z') } } } }).data).toEqual([{ k: null }, { k: 'z' }]);
  });

  it('finds no default for an attribute named as an object property', () => {
    const type = types.object({ constructor: types.string, toString: types.object({ k: types.string }), tls: types.object({ on: types.bool }, ['on']) }, [
      'constructor',
      'toString',
      'tls',
    ]);
    const tree = { values: { tls: constant({}) }, within: { tls: { values: { on: constant(true) } } } };

    expect(filledAs(written({}), type, tree).data).toEqual({ constructor: null, toString: null, tls: { on: true } });
  });

  it('gives an attribute of type any the type its default has', () => {
    const type = types.object({ x: types.dynamic }, ['x']);

    expect(filledAs(written({}), type, { values: { x: constant(n('1')) } })).toEqual(valueOf(types.object({ x: types.number }), { x: n('1') }));
  });

  it.each([
    [
      'one item gives and another leaves out',
      types.list(types.object({ x: types.dynamic }, ['x'])),
      {},
      [{ x: 'a' }, {}],
      types.list(types.object({ x: types.string })),
      [{ x: 'a' }, { x: null }],
    ],
    [
      'its default fills in',
      types.list(types.object({ x: types.dynamic }, ['x'])),
      { element: { values: { x: constant(n('1')) } } },
      [{}],
      types.list(types.object({ x: types.number })),
      [{ x: n('1') }],
    ],
    [
      'its default joins with what another item gives',
      types.list(types.object({ x: types.dynamic }, ['x'])),
      { element: { values: { x: constant(n('1')) } } },
      [{}, { x: 's' }],
      types.list(types.object({ x: types.string })),
      [{ x: '1' }, { x: 's' }],
    ],
  ])('reads the type of an optional any in a list from every item once filled in, where %s', (_, type, tree, data, expectedType, expected) => {
    expect(filledAs(written(data), type, tree)).toEqual(valueOf(expectedType, expected));
  });

  it('gives a filled item a type that requires every attribute', () => {
    expect(declaredAs('variable', 'v', written([{}]), types.list(types.object({ k: types.string }, ['k'])))).toEqual(
      valueOf(types.list(types.object({ k: types.string })), [{ k: null }])
    );
  });

  it('holds each member of a set once after its defaults fill it in, though it is taken as a list', () => {
    const members = valueOf(types.set(types.object({ k: types.string })), [{ k: null }, { k: 'z' }]);

    expect(filledAs(members, types.list(types.object({ k: types.string }, ['k'])), { element: { values: { k: constant('z') } } }).data).toEqual([{ k: 'z' }]);
  });

  it('holds each member of a set once when its defaults fill it in with a value of another type', () => {
    const members = valueOf(types.set(types.object({ x: types.string })), [{ x: null }, { x: '1' }]);

    expect(filledAs(members, types.list(types.object({ x: types.dynamic }, ['x'])), { element: { values: { x: constant(n('1')) } } }).data).toEqual([{ x: '1' }]);
  });

  it('takes a default in a set member as its attribute type before the members join', () => {
    const members = valueOf(types.set(types.object({ x: types.bool })), [{ x: null }, { x: true }]);

    expect(filledAs(members, types.set(types.object({ x: types.string }, ['x'])), { element: { values: { x: constant(n('1')) } } }).data).toEqual([{ x: '1' }, { x: 'true' }]);
  });

  it('takes a set as a tuple position by position, though its members could not join into one type', () => {
    const members = valueOf(types.set(types.object({ a: types.string })), [{ a: null }, { a: 'true' }]);
    const type = types.tuple([types.object({ a: types.number }, ['a']), types.object({ a: types.bool })]);

    expect(filledAs(members, type, { within: { 0: { values: { a: constant(n('1')) } } } }).data).toEqual([{ a: n('1') }, { a: true }]);
  });

  it('leaves a set with a member not known yet unknown as a whole when it is taken as a tuple', () => {
    const members = valueOf(types.set(types.object({ k: types.string })), [{ k: 'a' }, UNKNOWN]);

    expect(declaredAs('variable', 'v', members, types.tuple([types.object({ k: types.string }, ['k']), types.object({ k: types.string }, ['k'])])).data).toBe(UNKNOWN);
  });

  it('refuses a set member its declared type does not take, at its place in the set', () => {
    const members = valueOf(types.set(types.object({ x: types.dynamic })), [{ x: ['a'] }]);

    expect(mismatchOf(members, types.set(types.object({ x: types.string }, ['x']))).message).toBe('v[0]["x"] is a tuple, where variable "v" takes a string');
  });

  it('leaves a set with a member not known yet unknown as a whole when it is taken as a list', () => {
    const members = valueOf(types.set(types.object({ k: types.string })), [{ k: 'a' }, UNKNOWN]);

    expect(declaredAs('variable', 'v', members, types.list(types.object({ k: types.string }, ['k']))).data).toBe(UNKNOWN);
  });

  it.each([
    ['an attribute it requires left out', written({ tag: 't' }), 'variable "v" requires "name" in v'],
    ['an attribute it does not name', written({ name: 'a', nmae: 'b' }), 'variable "v" has no attribute "nmae" in v'],
  ])('still refuses %s beside one it fills in', (_, value, message) => {
    expect(mismatchOf(value, site).message).toBe(message);
  });

  it('leaves a value not known yet as it is, and fills in what is known around one', () => {
    const tree = { values: { tag: constant('t') } };

    expect(filledAs(valueOf(types.dynamic, UNKNOWN), site, tree)).toEqual(valueOf(types.object({ name: types.string, port: types.number, tag: types.string }), UNKNOWN));
    expect(filledAs(valueOf(types.object({ name: types.string }), { name: UNKNOWN }), site, tree).data).toEqual({ name: UNKNOWN, port: null, tag: 't' });
  });
});

function refusalOf(type: Type, tree: TypeDefaults): { node: AttributeValue; message: string } {
  let refusal: { node: AttributeValue; message: string } | undefined;
  checkDefaults('variable', 'v', type, { tree, read }, (node, check) => {
    try {
      check();
    } catch (error) {
      if (!(error instanceof SchemaMismatch)) throw error;
      refusal ??= { node, message: error.message };
    }
  });

  if (!refusal) throw new Error('Expected a default to be refused');
  return refusal;
}

describe('the defaults an object type gives', () => {
  it('refuses one that is not of its attribute type, at the default', () => {
    const port = constant('abc');

    expect(refusalOf(types.object({ port: types.number }, ['port']), { values: { port } })).toEqual({ node: port, message: 'port: "abc" is not a number' });
  });

  it('refuses one inside what a list holds, that leaves out an attribute its type requires', () => {
    const tls = constant({});
    const type = types.list(types.object({ tls: types.object({ cert: types.string }) }, ['tls']));

    expect(refusalOf(type, { element: { values: { tls } } })).toEqual({ node: tls, message: 'variable "v" requires "cert" in tls' });
  });

  it('refuses one inside another though the outer default gives its attribute a value', () => {
    const on = constant('nope');
    const type = types.object({ tls: types.object({ on: types.bool }, ['on']) }, ['tls']);

    expect(refusalOf(type, { values: { tls: constant({ on: true }) }, within: { tls: { values: { on } } } })).toEqual({
      node: on,
      message: 'on: "nope" is not a boolean, which is "true" or "false"',
    });
  });

  it('refuses one whose items cannot join once the defaults inside it fill them in', () => {
    const items = constant([{}, { x: n('1') }]);
    const type = types.object({ items: types.list(types.object({ x: types.dynamic }, ['x'])) }, ['items']);

    expect(refusalOf(type, { values: { items }, within: { items: { element: { values: { x: constant(true) } } } } })).toEqual({
      node: items,
      message: 'variable "v" cannot join a number and a boolean into one type, at .x in each item',
    });
  });

  it('refuses one in a tuple position', () => {
    const k = constant([]);
    const type = types.tuple([types.string, types.object({ k: types.string }, ['k'])]);

    expect(refusalOf(type, { within: { 1: { values: { k } } } })).toEqual({ node: k, message: 'k is a tuple, where variable "v" takes a string' });
  });

  it('takes every default that is of its type', () => {
    const type = types.object({ a: types.string, b: types.list(types.number) }, ['a', 'b']);
    const checked: AttributeValue[] = [];
    const a = constant(n('1'));
    const b = constant(['2']);

    checkDefaults('variable', 'v', type, { tree: { values: { a, b } }, read }, (node, check) => {
      check();
      checked.push(node);
    });

    expect(checked).toEqual([a, b]);
  });
});
