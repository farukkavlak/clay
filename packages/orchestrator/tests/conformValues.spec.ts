import { ExactNumber, Schema, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { conformValues as conform, SchemaMismatch } from '../src/conformValues';
import { inferred, valueOf } from '../src/Value';

const schema: Schema = {
  name: { type: types.string },
  size: { type: types.number },
  on: { type: types.bool },
  ports: { type: types.list(types.number) },
  ids: { type: types.set(types.number) },
  tags: { type: types.map(types.string) },
  anything: { type: types.list(types.dynamic) },
  settings: { type: types.object({ mode: types.string, depth: types.number }, ['depth']) },
  pair: { type: types.tuple([types.string, types.number]) },
};

const n = (text: string) => ExactNumber.parse(text);

/** As the configuration writes them: a list is a tuple and a map an object. */
const conformValues = (resource: string, held: Schema, config: Record<string, unknown>) =>
  conform(resource, held, Object.fromEntries(Object.entries(config).map(([name, data]) => [name, valueOf(inferred(data), data)])));

describe('conformValues', () => {
  it('takes a value of each type the schema names', () => {
    const config = {
      name: 'a',
      size: n('1'),
      on: true,
      ports: [n('80')],
      tags: { a: 'x' },
      anything: ['x', n('1'), [true]],
      settings: { mode: 'm', depth: n('2') },
    };

    expect(conformValues('thing', schema, config)).toEqual(config);
  });

  it.each([
    ['a number where it takes a string, as its text', { name: n('1.50') }, { name: '1.5' }],
    ['a boolean where it takes a string, as its text', { name: false }, { name: 'false' }],
    ['a string that spells a number where it takes one', { size: '1e3' }, { size: n('1000') }],
    ['a string that spells a boolean where it takes one', { on: 'true' }, { on: true }],
    ['each item of a list', { ports: ['80', n('443')] }, { ports: [n('80'), n('443')] }],
    ['each value of a map', { tags: { a: n('1'), b: true } }, { tags: { a: '1', b: 'true' } }],
    ['a value inside an object', { settings: { mode: 'm', depth: '2' } }, { settings: { mode: 'm', depth: n('2') } }],
    ['each item of a tuple, to the type its place names', { pair: [n('1'), '2'] }, { pair: ['1', n('2')] }],
  ])('takes %s', (_, config, conformed) => {
    expect(conformValues('thing', schema, config)).toEqual(conformed);
  });

  it.each([
    ['a string that is not a number where it takes one', { size: '5 MB' }, 'size: "5 MB" is not a number'],
    ['a string that spells a number out of range', { size: '1e99999999' }, 'size: "1e99999999" is out of range: a number reaches at most 1000 places either side of the point'],
    ['a string that is not a boolean where it takes one', { on: 'yes' }, 'on: "yes" is not a boolean, which is "true" or "false"'],
    ['a number where it takes a boolean', { on: n('1') }, 'on is a number, where thing takes a boolean'],
    ['a boolean where it takes a number', { size: true }, 'size is a boolean, where thing takes a number'],
    ['a tuple where it takes a string', { name: ['a'] }, 'name is a tuple, where thing takes a string'],
    ['an object where it takes a list', { ports: { a: n('1') } }, 'ports is an object, where thing takes a list'],
    ['a tuple where it takes a map', { tags: ['x'] }, 'tags is a tuple, where thing takes a map'],
    ['a tuple where it takes an object', { settings: ['m'] }, 'settings is a tuple, where thing takes an object'],
    ['an item of a list', { ports: [n('80'), 'http'] }, 'ports[1]: "http" is not a number'],
    ['a member of a set', { ids: [n('80'), 'http'] }, 'ids[1]: "http" is not a number'],
    ['an object where it takes a set', { ids: { a: n('1') } }, 'ids is an object, where thing takes a set'],
    ['a value of a map', { tags: { a: 'x', b: [true] } }, 'tags["b"] is a tuple, where thing takes a string'],
    ['a value inside an object', { settings: { mode: 'm', depth: 'deep' } }, 'settings["depth"]: "deep" is not a number'],
    ['a name an object does not have', { settings: { mode: 'm', moed: 'x' } }, 'thing has no attribute "moed" in settings'],
    ['a name an object requires and is not given', { settings: { depth: n('1') } }, 'thing requires "mode" in settings'],
    ['an item of a tuple', { pair: ['a', 'b'] }, 'pair[1]: "b" is not a number'],
    ['a tuple with too few items', { pair: ['a'] }, 'pair holds 1 item, where thing takes 2 items'],
    ['a tuple with too many items', { pair: ['a', n('1'), n('2')] }, 'pair holds 3 items, where thing takes 2 items'],
    ['an object where it takes a tuple', { pair: { a: 'x' } }, 'pair is an object, where thing takes a tuple'],
  ])('refuses %s, and names the attribute', (_, config, message) => {
    const attribute = Object.keys(config)[0];

    expect(() => conformValues('thing', schema, config)).toThrow(expect.objectContaining({ message, attribute }));
  });

  it('throws a SchemaMismatch, so the caller can place it at the attribute', () => {
    expect(() => conformValues('thing', schema, { name: [true] })).toThrow(SchemaMismatch);
  });

  // A saved plan's values reach the apply without the check the load makes.
  it('refuses a name the schema does not have, and names it', () => {
    expect(() => conformValues('thing', schema, { name: 'a', nmae: 'b' })).toThrow(expect.objectContaining({ message: 'thing has no attribute "nmae"', attribute: 'nmae' }));
  });

  it('refuses a name the schema requires and is not given, in no attribute', () => {
    const required: Schema = { path: { type: types.string, required: true } };

    expect(() => conformValues('thing', required, {})).toThrow(expect.objectContaining({ message: 'thing requires "path"', attribute: undefined }));
  });

  // Unknown parts are checked at apply; only the known parts are checked now.
  it.each([
    ['a whole value', { name: UNKNOWN, settings: UNKNOWN }],
    ['an item of a list', { ports: [n('80'), UNKNOWN] }],
    ['a value of a map', { tags: { a: UNKNOWN } }],
    ['a value inside an object', { settings: { mode: UNKNOWN, depth: n('2') } }],
  ])('takes %s not known yet, as it is', (_, config) => {
    expect(conformValues('thing', schema, config)).toEqual(config);
  });

  it.each([
    ['beside a value', { mode: 'm' }],
    ['beside a value not known yet', { mode: UNKNOWN }],
  ])('gives an optional attribute an object leaves out as null, %s', (_, settings) => {
    expect(conformValues('thing', schema, { settings })).toEqual({ settings: { ...settings, depth: null } });
  });

  it('holds an object once in a set, with its optional attribute left out and set to null', () => {
    const rules: Schema = { rules: { type: types.set(schema.settings.type) } };

    expect(conformValues('thing', rules, { rules: [{ mode: 'm' }, { mode: 'm', depth: null }] })).toEqual({ rules: [{ mode: 'm', depth: null }] });
  });

  it('keeps the attributes of an object in the order they are written', () => {
    const { settings } = conformValues('thing', schema, { settings: { depth: n('2'), mode: 'm' } });

    expect(Object.keys(settings as object)).toEqual(['depth', 'mode']);
  });

  // Converted first, so "80" and 80 become one member.
  it('converts each member of a set, then holds it once and in order', () => {
    expect(conformValues('thing', schema, { ids: ['80', n('443'), n('80')] })).toEqual({ ids: [n('80'), n('443')] });
  });

  // An unknown member may become anything, so it is kept after the known members.
  it('checks a known member of a set beside one not known, and keeps both', () => {
    expect(conformValues('thing', schema, { ids: [UNKNOWN, '80'] })).toEqual({ ids: [n('80'), UNKNOWN] });
    expect(() => conformValues('thing', schema, { ids: [UNKNOWN, 'http'] })).toThrow('ids[1]: "http" is not a number');
  });

  it('checks and converts what is known beside what is not', () => {
    expect(conformValues('thing', schema, { tags: { a: UNKNOWN, b: n('1') } })).toEqual({ tags: { a: UNKNOWN, b: '1' } });
    expect(() => conformValues('thing', schema, { tags: { a: UNKNOWN, b: ['x'] } })).toThrow('tags["b"] is a tuple, where thing takes a string');
  });

  // `dynamic` names no type, so nothing is converted.
  it('takes any value where the type is dynamic, as it is', () => {
    const config = { meta: { any: 'x', thing: n('1') }, items: ['1', n('1'), [true]] };

    expect(conformValues('thing', { meta: { type: types.map(types.dynamic) }, items: { type: types.list(types.dynamic) } }, config)).toEqual(config);
  });

  it('leaves out a name set to null, as if it were not set', () => {
    expect(conformValues('thing', schema, { name: null, size: n('1') })).toEqual({ size: n('1') });
  });

  // The name is written, so the error points at it.
  it('refuses null for a name the schema requires, and names the attribute', () => {
    const required: Schema = { path: { type: types.string, required: true } };

    expect(() => conformValues('thing', required, { path: null })).toThrow(expect.objectContaining({ message: 'thing requires "path"', attribute: 'path' }));
  });

  it('keeps null inside a list, a map and a set, as null of the type its place names', () => {
    expect(conformValues('thing', schema, { ports: [null, '80'], tags: { a: null }, ids: [null, '1'] })).toEqual({
      ports: [null, n('80')],
      tags: { a: null },
      ids: [n('1'), null],
    });
  });

  // Its type is known before its value, so a value that can never fit is refused at plan.
  it('refuses a value not known yet whose kind the schema does not take', () => {
    expect(() => conform('thing', schema, { ports: valueOf(types.string, UNKNOWN) })).toThrow(
      expect.objectContaining({ message: 'ports is a string, where thing takes a list', attribute: 'ports' })
    );
  });

  it('takes a value not known yet of a kind that converts, as not known', () => {
    expect(conform('thing', schema, { size: valueOf(types.string, UNKNOWN), ports: valueOf(types.dynamic, UNKNOWN) })).toEqual({ size: UNKNOWN, ports: UNKNOWN });
  });

  it('takes a set where a list goes, as its members in order', () => {
    expect(conform('thing', schema, { ports: valueOf(types.set(types.string), ['1', '2']) })).toEqual({ ports: [n('1'), n('2')] });
  });

  // An unknown member may sort anywhere or duplicate one, so as a list it has no order or length before apply.
  it('takes a set with a member not known yet as not known, anywhere but where a set goes', () => {
    const members = valueOf(types.set(types.string), ['1', UNKNOWN]);
    const three = valueOf(types.set(types.string), ['1', 'a', UNKNOWN]);

    expect(conform('thing', schema, { ports: members, ids: members, pair: three })).toEqual({ ports: UNKNOWN, ids: [n('1'), UNKNOWN], pair: UNKNOWN });
  });

  it('takes such a set as not known at any depth of a value whose type is dynamic', () => {
    const members = types.set(types.string);
    const meta = valueOf(types.object({ m: members, k: types.tuple([members, members]) }), { m: ['z', UNKNOWN], k: [['a'], [UNKNOWN]] });

    expect(conform('thing', { meta: { type: types.dynamic } }, { meta })).toEqual({ meta: { m: UNKNOWN, k: [['a'], UNKNOWN] } });
  });
});
