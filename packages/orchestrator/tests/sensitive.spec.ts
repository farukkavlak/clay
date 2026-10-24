import { EVERY_ITEM, ExactNumber, isMaybe, MAYBE, sensitiveUnder, SOMEWHERE, types, UNKNOWN } from '@clay/contracts';
import { ConfigError } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { converted, SchemaMismatch } from '../src/conformValues';
import { declaredAs, givenTo } from '../src/declared';
import { forObject, laterObjectMarks } from '../src/forItems';
import { readPath } from '../src/resolvers/readPath';
import {
  allSensitive,
  child,
  everyItemMarks,
  fewest,
  inferred,
  isSensitive,
  itemsOf,
  mayBeSensitive,
  objectOf,
  sharedMarks,
  tupleOf,
  Value,
  valueOf,
  wholeOf,
  withSensitive,
} from '../src/Value';
import { steps } from './ast';

const at = { file: 'main.clay', line: 1, column: 1 };

/** As the configuration writes it: a list is a tuple and a map an object. */
const written = (data: unknown): Value => valueOf(inferred(data), data);

const secret = allSensitive(valueOf(types.string, 's3cret'));

describe('the sensitive parts of a value', () => {
  it('are left out where it has none, so it is the value it was', () => {
    expect(withSensitive(written('a'), [])).toEqual({ type: types.string, data: 'a' });
    expect(tupleOf([written('a')])).not.toHaveProperty('sensitive');
  });

  it('are the whole value where the whole is among them', () => {
    expect(withSensitive(written({ a: 'x' }), [['a'], []]).sensitive).toEqual([[]]);
  });

  it('are kept by the step to each, in a tuple and an object made of values', () => {
    const conn = objectOf([
      ['name', written('app')],
      ['password', secret],
    ]);

    expect(conn.sensitive).toEqual([['password']]);
    expect(tupleOf([written('a'), conn]).sensitive).toEqual([[1, 'password']]);
  });

  it('follow a step into the value: the part reached is sensitive, another is not', () => {
    const list = tupleOf([written('a'), objectOf([['password', secret]])]);

    expect(child(list, 0)).not.toHaveProperty('sensitive');
    expect(child(list, 1).sensitive).toEqual([['password']]);
    expect(child(child(list, 1), 'password').sensitive).toEqual([[]]);
  });

  it('are every part of a value that is sensitive as a whole', () => {
    expect(child(allSensitive(written(['a'])), 0).sensitive).toEqual([[]]);
  });

  it('stay where they were in a list or a map the value is given as', () => {
    const list = tupleOf([written('a'), secret]);
    const conn = objectOf([['password', secret]]);

    expect(converted('v', list, types.list(types.string), ['v']).sensitive).toEqual([[1]]);
    expect(converted('v', conn, types.map(types.string), ['v']).sensitive).toEqual([['password']]);
    expect(converted('v', conn, types.dynamic, ['v']).sensitive).toEqual([['password']]);
  });

  // A set is sorted and holds each member once, so where a member sits and how many there are give it away.
  it('are the whole set where a member is one, however deep the set is', () => {
    const members = tupleOf([written('b'), secret]);

    expect(converted('v', members, types.set(types.string), ['v']).sensitive).toEqual([[]]);
    expect(converted('v', objectOf([['ids', members]]), types.object({ ids: types.set(types.string) }), ['v']).sensitive).toEqual([['ids']]);
  });

  it('travel with a value not known yet, to the part a reference reads', () => {
    const later = withSensitive(valueOf(types.object({ name: types.string, password: types.string }), UNKNOWN), [['password']]);

    expect(() => readPath(later, 'local.conn', steps('password'), at)).toThrow(expect.objectContaining({ type: types.string, sensitive: [[]] }));
    expect(() => readPath(later, 'local.conn', steps('name'), at)).toThrow(expect.objectContaining({ type: types.string, sensitive: [] }));
  });
});

const FIT = 'does not fit what thing takes; it is sensitive, so its parts are not shown';

const keyed = allSensitive(written({ s3cret: 'x' }));

const conn = objectOf([
  ['enabled', written('yes')],
  ['password', secret],
]);

describe('whether a value is sensitive for certain', () => {
  const list = valueOf(types.list(types.string), UNKNOWN);

  it.each([
    ['a value not known yet sensitive as a whole', allSensitive(list), true],
    ['a value not known yet marked at a key', withSensitive(valueOf(types.map(types.string), UNKNOWN), [['a']]), true],
    ['a list not known yet marked under every item, which may come out empty', withSensitive(list, [[EVERY_ITEM]]), false],
    ['a known list marked under every item', withSensitive(written(['x']), [[EVERY_ITEM]]), true],
    ['an empty list marked under every item', withSensitive(written([]), [[EVERY_ITEM]]), false],
    ['a known object holding a list not known yet marked under every item', withSensitive(written({ o: UNKNOWN }), [['o', EVERY_ITEM]]), false],
    ['a known list whose second item has a part marked under every item of the first', withSensitive(written([[], ['x']]), [[EVERY_ITEM, EVERY_ITEM]]), true],
  ])('of %s', (_, value, sensitive) => {
    expect(isSensitive(value)).toBe(sensitive);
  });
});

describe('the marks a value may have', () => {
  const pair = written({ a: 'x', b: 'y' });
  const list = valueOf(types.list(types.string), UNKNOWN);

  it.each([
    ['a part one value marks, where another has none', [withSensitive(pair, [['a']]), pair], [['a', MAYBE]]],
    ['the whole, where one value is sensitive as a whole', [allSensitive(written('x')), written('y')], [[MAYBE]]],
    ['none beside a part every value marks', [withSensitive(pair, [['a']]), withSensitive(pair, [['a']])], [['a']]],
    [
      'the parts it may be at, where one value is sensitive somewhere',
      [withSensitive(pair, [[SOMEWHERE], ['a', MAYBE], ['b', MAYBE]]), pair],
      [
        ['a', MAYBE],
        ['b', MAYBE],
      ],
    ],
    ['every item, where one value marks every item', [withSensitive(list, [[EVERY_ITEM]]), written(['y'])], [[EVERY_ITEM, MAYBE]]],
    ['none for certain, where one value only may be sensitive and another is at a part', [withSensitive(pair, [[MAYBE]]), withSensitive(pair, [['a']])], [[MAYBE]]],
    ['a part that may be once, where one value already may have it', [withSensitive(pair, [['a', MAYBE]]), pair], [['a', MAYBE]]],
  ])('are %s', (_, values, marks) => {
    expect(sharedMarks(values)).toEqual(marks);
  });

  it.each([
    [
      'one that may be beside one for certain under it',
      [
        ['a', MAYBE],
        ['a', 'b'],
      ],
      [
        ['a', MAYBE],
        ['a', 'b'],
      ],
    ],
    [
      'one that may be under another that may be',
      [
        ['a', 'b', MAYBE],
        ['a', MAYBE],
      ],
      [['a', MAYBE]],
    ],
    [
      'one that may be at an item, under every item that may be',
      [
        [0, MAYBE],
        [EVERY_ITEM, MAYBE],
      ],
      [[EVERY_ITEM, MAYBE]],
    ],
    ['one that may be under one for certain', [['a', 'b', MAYBE], ['a']], [['a']]],
  ])('keep, of the fewest, %s', (_, paths, kept) => {
    expect(fewest(paths)).toEqual(kept);
  });

  it.each([
    ['a part that may be, at it', [['a', MAYBE]], 'a', [[MAYBE]]],
    ['a part that may be, at another', [['a', MAYBE]], 'b', []],
    ['the whole that may be', [[MAYBE]], 'a', [[MAYBE]]],
    ['a value sensitive somewhere, at a part it may be at', [[SOMEWHERE], ['a', MAYBE]], 'a', [[MAYBE]]],
    ['a value sensitive somewhere, at a part it is not at', [[SOMEWHERE], ['a', MAYBE]], 'b', []],
    ['the whole that may be, at a key spelled as maybe', [[MAYBE]], '-3', [[MAYBE]]],
  ])('are below a step, for %s', (_, paths, step, below) => {
    expect(sensitiveUnder(paths, step)).toEqual(below);
  });

  it.each([
    ['at a part of a map not known yet', withSensitive(valueOf(types.map(types.string), UNKNOWN), [['a', MAYBE]])],
    ['as a whole of a tuple not known yet', withSensitive(valueOf(types.tuple([types.string]), UNKNOWN), [[MAYBE]])],
  ])('are not sensitive for certain, though they may be, %s', (_, value) => {
    expect([isSensitive(value), mayBeSensitive(value)]).toEqual([false, true]);
  });

  it.each([
    ['the whole, where one value is sensitive for certain', [withSensitive(pair, [['a']]), pair], [[]]],
    ['the whole as one that may be, where one value may be', [withSensitive(pair, [['a', MAYBE]]), pair], [[MAYBE]]],
    ['none, where no value has a mark', [pair, pair], []],
  ])('of a value made from others are %s', (_, values, marks) => {
    expect(wholeOf(...values)).toEqual(marks);
  });
});

describe('the marks some values all have', () => {
  const marked = (...paths: (string | number)[][]) => withSensitive(written({ a: 'x', b: 'y' }), paths);

  it.each([
    ['none where one value has none', [marked(['a']), written({ a: 'x', b: 'y' })], []],
    ['a part every value marks', [marked(['a']), marked(['a'], ['b'])], [['a']]],
    ['a part one value marks and another holds in one marked whole', [marked(['a']), allSensitive(written({ a: 'x' }))], [['a']]],
    ['the whole where every value is sensitive as a whole', [allSensitive(written('x')), allSensitive(written('y'))], [[]]],
    [
      'the part both mark where one marks it under every item of a list and another at one',
      [withSensitive(written([{ a: 'x' }]), [[EVERY_ITEM, 'a']]), withSensitive(written([{ a: 'y' }]), [[0, 'a']])],
      [[0, 'a']],
    ],
    [
      'the part where a mark under every item meets one at an item',
      [withSensitive(written([{ a: 'x' }]), [[EVERY_ITEM, 'a']]), withSensitive(written([{ a: 'y' }]), [[0]])],
      [[0, 'a']],
    ],
    [
      'the part where two marks under every item meet',
      [withSensitive(written([{ a: 'x' }]), [[EVERY_ITEM, 'a']]), withSensitive(written([{ a: 'y' }]), [[0, EVERY_ITEM]])],
      [[0, 'a']],
    ],
    ['one path for an index written as a number or as text', [withSensitive(written(['x']), [[0], ['0']]), withSensitive(written(['y']), [[0]])], [[0]]],
    [
      'a mark at an item beside one under every item, since only the first says the item is there',
      [withSensitive(written(['x']), [[EVERY_ITEM], [0]]), withSensitive(written(['y']), [[EVERY_ITEM]])],
      [[EVERY_ITEM], [0]],
    ],
    [
      'none at an item a list not known yet may lack, where it marks every item',
      [withSensitive(valueOf(types.list(types.string), UNKNOWN), [[EVERY_ITEM]]), withSensitive(written(['y']), [[0]])],
      [],
    ],
    ['none at a key a value sensitive as a whole may lack', [allSensitive(valueOf(types.map(types.string), UNKNOWN)), withSensitive(written({ a: 'x' }), [['a']])], []],
    [
      'the attribute an object not known yet holds, where it is sensitive as a whole',
      [allSensitive(valueOf(types.object({ a: types.string }), UNKNOWN)), withSensitive(written({ a: 'x' }), [['a']])],
      [['a']],
    ],
    [
      'none at an item under every item that one item lacks',
      [withSensitive(written([[], ['x']]), [[EVERY_ITEM, EVERY_ITEM]]), withSensitive(written([['y'], ['z']]), [[EVERY_ITEM, 0]])],
      [],
    ],
    [
      'the item a tuple not known yet holds, where it marks every item',
      [withSensitive(valueOf(types.tuple([types.string]), UNKNOWN), [[EVERY_ITEM]]), withSensitive(written(['y']), [[0]])],
      [[0]],
    ],
    ['somewhere where each value marks another part', [marked(['a']), marked(['b'])], [[SOMEWHERE]]],
    [
      'somewhere in the part both hold where each marks another part of it',
      [withSensitive(written({ o: { a: 'x', b: 'y' } }), [['o', 'a']]), withSensitive(written({ o: { a: 'x', b: 'y' } }), [['o', 'b']])],
      [['o', SOMEWHERE]],
    ],
    ['somewhere where one value is sensitive somewhere and another at a part', [marked([SOMEWHERE]), marked(['a'])], [[SOMEWHERE]]],
    ['a part every value marks, with no somewhere it already tells', [marked(['a'], ['b']), marked(['a'])], [['a']]],
    [
      'a part every value marks at a key spelled as somewhere',
      [withSensitive(written({ '-2': 'x' }), [[SOMEWHERE], ['-2']]), withSensitive(written({ '-2': 'x' }), [['-2']])],
      [['-2']],
    ],
    ['none somewhere where one mark is under every item of what may come out empty', [withSensitive(written({ a: UNKNOWN, b: 'y' }), [['a', EVERY_ITEM]]), marked(['b'])], []],
    [
      'somewhere beside a mark under every item, which may mark nothing',
      [withSensitive(written({ a: UNKNOWN, b: 'y' }), [['a', EVERY_ITEM], ['b']]), withSensitive(written({ a: ['x'], c: 'z' }), [['a', EVERY_ITEM], ['c']])],
      [['a', EVERY_ITEM], [SOMEWHERE]],
    ],
    [
      'none somewhere at an item one value marks only under every item, where that item lacks the part',
      [withSensitive(valueOf(types.list(types.map(types.string)), [{}, { a: 'x' }]), [[EVERY_ITEM, 'a']]), withSensitive(written([{ b: 'y' }, {}]), [[0, 'b']])],
      [],
    ],
    ['none for no values', [], []],
  ])('are %s', (_, values, marks) => {
    expect(sharedMarks(values).filter((path) => !isMaybe(path))).toEqual(marks);
  });

  it('are none at a part not known yet of a known value sensitive somewhere, since that part has its own marks', () => {
    expect(child(withSensitive(written({ '-2': UNKNOWN }), [[SOMEWHERE]]), '-2').sensitive).toBeUndefined();
  });

  it.each([
    ['none, where it is sensitive somewhere', [[SOMEWHERE]], undefined],
    ['only those for certain, where it is sensitive somewhere and at that part', [[SOMEWHERE], ['-2', 'q']], [['q']]],
  ])('are, at a known part of a value, %s, since what is sensitive somewhere lies in a part not known yet', (_, marks, below) => {
    expect(child(withSensitive(written({ a: UNKNOWN, '-2': { q: 'x' } }), marks), '-2').sensitive).toEqual(below);
  });

  it('are maybe at a part of a value that may be sensitive as a whole', () => {
    expect(child(withSensitive(written({ a: UNKNOWN, b: 'x' }), [[SOMEWHERE], [MAYBE]]), 'b').sensitive).toEqual([[MAYBE]]);
  });

  it.each([
    ['the part that may be', [['a', MAYBE]], { a: UNKNOWN, b: ['y', 'z'] }],
    ['every item that may be', [['b', EVERY_ITEM, MAYBE]], { a: 'x', b: [UNKNOWN, UNKNOWN] }],
    ['the whole that may be', [[MAYBE]], UNKNOWN],
    ['nothing, where a part is sensitive for certain', [['a']], { a: 'x', b: ['y', 'z'] }],
  ])('leave not known yet %s', (_, marks, data) => {
    expect(withSensitive(written({ a: 'x', b: ['y', 'z'] }), marks).data).toEqual(data);
  });

  it('keep a mark under every item beside one at a key spelled as every item', () => {
    expect(fewest([['-1'], [EVERY_ITEM, 'a']])).toEqual([['-1'], [EVERY_ITEM, 'a']]);
  });

  it('are under every item where each item may be any of them', () => {
    expect(everyItemMarks([marked(['a']), marked(['a'])])).toEqual([[EVERY_ITEM, 'a']]);
  });

  it.each([
    ['a key', false, [['a', MAYBE]]],
    ['a group', true, [['a', EVERY_ITEM, MAYBE]]],
  ])('of %s a for may drop are only ones it may have, since the key may not be there', (_, grouped, marks) => {
    const entries: [Value, Value][] = [
      [written('a'), allSensitive(valueOf(types.string, UNKNOWN))],
      [written('c'), valueOf(types.string, UNKNOWN)],
    ];

    expect(laterObjectMarks(entries, [false, true], grouped)).toEqual(marks);
  });

  it('are under every item as ones it may have only where a value not at a named key or place has them', () => {
    expect(everyItemMarks([marked(['a']), marked(), marked(['b'])], [marked(['b'])])).toEqual([[EVERY_ITEM, 'b', MAYBE]]);
  });

  it.each([
    ['one for each item of a list', withSensitive(written(['x', 'y']), [[1]]), [written('x'), allSensitive(written('y'))]],
    ['none for an empty list', written([]), []],
    [
      'one with what every item has for a list not known yet',
      withSensitive(valueOf(types.list(types.string), UNKNOWN), [[EVERY_ITEM]]),
      [allSensitive(valueOf(types.dynamic, UNKNOWN))],
    ],
  ])('of a collection are %s', (_, collection, items) => {
    expect(itemsOf(collection)).toEqual(items);
  });
});

describe('an error about a value with a sensitive part', () => {
  it.each([
    ['a sensitive string that is no boolean', secret, types.bool, 'v: (sensitive value) is not a boolean, which is "true" or "false"'],
    ['a sensitive string that is no number', secret, types.number, 'v: (sensitive value) is not a number'],
    [
      'a sensitive string that spells a number out of range',
      allSensitive(written('1e2000')),
      types.number,
      'v: (sensitive value) is out of range: a number reaches at most 1000 places either side of the point',
    ],
    ['the sensitive part of an object', conn, types.object({ enabled: types.string, password: types.number }), 'v["password"]: (sensitive value) is not a number'],
    ['a name its type does not have, in an object sensitive as a whole', keyed, types.object({ a: types.string }), `v ${FIT}`],
    ['a string that is no boolean under a key of a map sensitive as a whole', keyed, types.map(types.bool), `v ${FIT}`],
    ['a string where a list is taken, under a key of a map sensitive as a whole', keyed, types.map(types.list(types.string)), `v ${FIT}`],
    ['more items than its tuple takes, in a list sensitive as a whole', allSensitive(written(['a', 'b'])), types.tuple([types.string]), `v ${FIT}`],
    ['an object sensitive as a whole inside one that is not', objectOf([['conn', keyed]]), types.object({ conn: types.map(types.bool) }), `v["conn"] ${FIT}`],
  ])('shows nothing of it, for %s', (_, value, type, message) => {
    expect(() => converted('thing', value, type, ['v'])).toThrow(new SchemaMismatch(message, 'v'));
  });

  it('still quotes a part that is not sensitive, beside one that is', () => {
    const type = types.object({ enabled: types.bool, password: types.string });

    expect(() => converted('thing', conn, type, ['v'])).toThrow(new SchemaMismatch('v["enabled"]: "yes" is not a boolean, which is "true" or "false"', 'v'));
  });

  it.each([
    ['both', secret, secret],
    ['the first', secret, written('s3cret')],
    ['the second', written('s3cret'), secret],
  ])('does not quote a key two items of a for give, where %s is sensitive', (_, first, second) => {
    const one = written(ExactNumber.parse('1'));
    const entries: [Value, Value][] = [
      [first, one],
      [second, one],
    ];

    expect(() => forObject(entries, false, { sensitive: false, maybe: false }, at)).toThrow(
      new ConfigError('Two items give the key (sensitive value); write "..." after the value to group them', at)
    );
  });

  it('does not name the keys of items that share no type, where a part is sensitive', () => {
    const items = tupleOf([written({ a: 'x' }), keyed]);

    expect(() => declaredAs('variable', 'v', items, types.list(types.dynamic))).toThrow(
      new SchemaMismatch('variable "v" cannot join what it holds into one type; a part of it is sensitive, so no more is shown', 'v')
    );
  });

  it('does not name a key on the way to a set member that does not fit, in a map sensitive as a whole', () => {
    const member = types.object({ a: types.bool }, ['a']);
    const sets = allSensitive(valueOf(types.object({ s3cret: types.set(types.object({ a: types.string })) }), { s3cret: [{ a: 'yes' }] }));

    expect(() => declaredAs('variable', 'v', sets, types.map(types.set(member)))).toThrow(
      new SchemaMismatch('v does not fit what variable "v" takes; it is sensitive, so its parts are not shown', 'v')
    );
  });

  it('does not say how many items a list sensitive as a whole holds', () => {
    expect(() => readPath(allSensitive(written(['a'])), 'local.list', [{ key: 5 }], at)).toThrow(new ConfigError('local.list has no item [5]', at));
    expect(() => readPath(tupleOf([written('a'), secret]), 'local.list', [{ key: 5 }], at)).toThrow(new ConfigError('local.list has no item [5]: it holds 2', at));
  });

  it('shows nothing of what a block marked sensitive is given, though the value itself is not marked', () => {
    const declared = { type: types.number, sensitive: true as const };

    expect(() => givenTo('output', 'password', written('s3cret'), declared, () => secret)).toThrow(new SchemaMismatch('password: (sensitive value) is not a number', 'password'));
  });
});
