import { EVERY_ITEM, EXACT, ExactNumber, holdsFirst, isMaybe, MAYBE, sensitiveUnder, SOMEWHERE, types, UNKNOWN } from '@clay/contracts';
import { ConfigError } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { converted, SchemaMismatch, sensitiveAs } from '../../src/values/conformValues';
import { declaredAs, givenTo } from '../../src/values/declared';
import { forObject, laterObjectMarks, pickedTupleMarks } from '../../src/expressions/forItems';
import { readPath } from '../../src/expressions/readPath';
import { schemaMarked } from '../../src/values/schemaMarks';
import { allSensitive, child, inferred, mayBeSensitive, objectOf, tupleOf, Value, valueOf, withSensitive } from '../../src/values/Value';
import { anyItemMarks, everyItemMarks, fewest, isSensitive, itemsOf, maybeMarks, sharedMarks, wholeOf } from '../../src/values/sensitive';
import { steps } from '../ast';

const at = { file: 'main.clay', line: 1, column: 1 };

/** As the configuration writes it: a list is a tuple and a map an object. */
const written = (data: unknown): Value => valueOf(inferred(data), data);

const secret = allSensitive(valueOf(types.string, 's3cret'));

/** A map not known yet with these marks. */
const laterMap = (...paths: (string | number)[][]) => withSensitive(valueOf(types.map(types.dynamic), UNKNOWN), paths);

/** What the marks leave at `c` of the item at `place`. */
const cAt = (marks: (string | number)[][], place: number) => sensitiveUnder(sensitiveUnder(marks, place), 'c');

/** A map not known yet with these marks below its key `w`. */
const below = (...paths: (string | number)[][]) => laterMap(...paths.map((path) => ['w', ...path]));

describe('the sensitive parts of a value', () => {
  it('are left out where it has none, so it is the value it was', () => {
    expect(withSensitive(written('a'), [])).toEqual({ type: types.string, data: 'a' });
    expect(tupleOf([written('a')])).not.toHaveProperty('sensitive');
  });

  it('are the whole value where the whole is among them', () => {
    expect(withSensitive(written({ a: 'x' }), [['a'], []]).marks?.paths()).toEqual([[]]);
  });

  it('are kept by the step to each, in a tuple and an object made of values', () => {
    const conn = objectOf([
      ['name', written('app')],
      ['password', secret],
    ]);

    expect(conn.marks?.paths()).toEqual([['password']]);
    expect(tupleOf([written('a'), conn]).marks?.paths()).toEqual([[1, 'password']]);
  });

  it('follow a step into the value: the part reached is sensitive, another is not', () => {
    const list = tupleOf([written('a'), objectOf([['password', secret]])]);

    expect(child(list, 0)).not.toHaveProperty('sensitive');
    expect(child(list, 1).marks?.paths()).toEqual([['password']]);
    expect(child(child(list, 1), 'password').marks?.paths()).toEqual([[]]);
  });

  it('are every part of a value that is sensitive as a whole', () => {
    expect(child(allSensitive(written(['a'])), 0).marks?.paths()).toEqual([[]]);
  });

  it('stay where they were in a list or a map the value is given as', () => {
    const list = tupleOf([written('a'), secret]);
    const conn = objectOf([['password', secret]]);

    expect(converted('v', list, types.list(types.string), ['v']).marks?.paths()).toEqual([[1]]);
    expect(converted('v', conn, types.map(types.string), ['v']).marks?.paths()).toEqual([['password']]);
    expect(converted('v', conn, types.dynamic, ['v']).marks?.paths()).toEqual([['password']]);
  });

  // A set is sorted and holds each member once, so where a member sits and how many there are give it away.
  it('are the whole set where a member is one, however deep the set is', () => {
    const members = tupleOf([written('b'), secret]);

    expect(converted('v', members, types.set(types.string), ['v']).marks?.paths()).toEqual([[]]);
    expect(converted('v', objectOf([['ids', members]]), types.object({ ids: types.set(types.string) }), ['v']).marks?.paths()).toEqual([['ids']]);
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
    ['one for certain under one for certain', [['a'], ['a', 'b']], [['a']]],
  ])('keep, of the fewest, %s', (_, paths, kept) => {
    expect(fewest(paths)).toEqual(kept);
  });

  it('keep the fewest of a mark with a step every item, or a key spelled as one, at every depth in time that grows with its depth', () => {
    const deep = [...Array.from({ length: 24 }, () => EVERY_ITEM), MAYBE];
    const spelledAlike = [...Array.from({ length: 24 }, () => '-1'), MAYBE];
    const started = performance.now();

    expect(fewest([deep, ['x', MAYBE]])).toEqual([deep, ['x', MAYBE]]);
    expect(fewest([spelledAlike, [EVERY_ITEM, MAYBE]])).toEqual([[EVERY_ITEM, MAYBE]]);
    // Well under a millisecond where it grows with the depth, and seconds where each step every item doubles what is looked at.
    expect(performance.now() - started).toBeLessThan(1000);
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

/** Exact keys under as many keys, beside marks that may be so under every item and at each of those keys. */
function manyMarks(size: number) {
  const keys = Array.from({ length: size }, (_, index) => `k${index}`);
  return [
    [EVERY_ITEM, EVERY_ITEM, MAYBE],
    ...keys.map((key) => [EVERY_ITEM, key, MAYBE]),
    ...keys.map((key) => [`m${key}`, key, EXACT]),
    ...keys.map((key) => [`m${key}`, EVERY_ITEM, MAYBE]),
  ];
}

/** Milliseconds `fewest` takes over `manyMarks(size)`. */
function keptFewestIn(size: number): number {
  const started = performance.now();
  fewest(manyMarks(size));
  return performance.now() - started;
}

describe('an exact key or place', () => {
  it.each([
    [
      'one that may be at it, beside one that may be under every item',
      [
        [EVERY_ITEM, MAYBE],
        ['c', MAYBE],
        ['c', EXACT],
      ],
      [
        [EVERY_ITEM, MAYBE],
        ['c', MAYBE],
        ['c', EXACT],
      ],
    ],
    ['a value sensitive somewhere, beside it', [[SOMEWHERE], [EVERY_ITEM, MAYBE], [0, EXACT]], [[SOMEWHERE], [EVERY_ITEM, MAYBE], [0, EXACT]]],
    [
      'none where it keeps nothing out',
      [
        ['c', EXACT],
        ['c', 'p'],
      ],
      [['c', 'p']],
    ],
    [
      'none where what may be so under every item is under another key',
      [
        ['a', 'c', EXACT],
        ['b', EVERY_ITEM, MAYBE],
      ],
      [['b', EVERY_ITEM, MAYBE]],
    ],
    [
      'none that may be at a key of the same name under another key',
      [
        ['a', 'c', EXACT],
        ['a', EVERY_ITEM, MAYBE],
        ['b', EVERY_ITEM, MAYBE],
        ['b', 'c', MAYBE],
      ],
      [
        ['a', 'c', EXACT],
        ['a', EVERY_ITEM, MAYBE],
        ['b', EVERY_ITEM, MAYBE],
      ],
    ],
    [
      'it, beside a mark at a key spelled as it',
      [
        ['c', '-4'],
        ['c', EXACT],
        [EVERY_ITEM, MAYBE],
      ],
      [
        ['c', '-4'],
        ['c', EXACT],
        [EVERY_ITEM, MAYBE],
      ],
    ],
    ['none that may be at it, under every item for certain', [[EVERY_ITEM], [EVERY_ITEM, 'z', MAYBE], ['c', MAYBE], ['c', EXACT]], [[EVERY_ITEM], ['c', EXACT]]],
    ['none for the whole', [[EVERY_ITEM, MAYBE], [EXACT]], [[EVERY_ITEM, MAYBE]]],
    [
      'none under a marker, beside what may be so under every item under a key spelled as it',
      [
        ['-2', EVERY_ITEM, MAYBE],
        [SOMEWHERE, 'c', EXACT],
      ],
      [['-2', EVERY_ITEM, MAYBE]],
    ],
    [
      'it, beside what may be so under every item under every item',
      [
        [EVERY_ITEM, EVERY_ITEM, MAYBE],
        ['x', 'c', EXACT],
      ],
      [
        [EVERY_ITEM, EVERY_ITEM, MAYBE],
        ['x', 'c', EXACT],
      ],
    ],
    [
      'it under every item, beside what may be so under every item under a key',
      [
        ['x', EVERY_ITEM, MAYBE],
        [EVERY_ITEM, 'c', EXACT],
      ],
      [
        ['x', EVERY_ITEM, MAYBE],
        [EVERY_ITEM, 'c', EXACT],
      ],
    ],
    [
      'one that may be at it under every item, beside it under a key',
      [
        [EVERY_ITEM, EVERY_ITEM, MAYBE],
        [EVERY_ITEM, 'c', MAYBE],
        ['x', 'c', EXACT],
      ],
      [
        [EVERY_ITEM, EVERY_ITEM, MAYBE],
        [EVERY_ITEM, 'c', MAYBE],
        ['x', 'c', EXACT],
      ],
    ],
    [
      'one that may be at it under a key, beside it under every item',
      [
        ['x', EVERY_ITEM, MAYBE],
        ['x', 'c', MAYBE],
        [EVERY_ITEM, 'c', EXACT],
      ],
      [
        ['x', EVERY_ITEM, MAYBE],
        ['x', 'c', MAYBE],
        [EVERY_ITEM, 'c', EXACT],
      ],
    ],
  ])('keeps, of the fewest, %s', (_, paths, kept) => {
    expect(fewest(paths)).toEqual(kept);
  });

  it('and the marks beside it are kept fewest in time that grows with them', () => {
    keptFewestIn(1000);

    // About four where it grows with them, and sixteen where each mark is held against every other.
    expect(keptFewestIn(16_000) / keptFewestIn(4000)).toBeLessThan(8);
  });

  it('is no mark of a value alone', () => {
    expect(mayBeSensitive(laterMap(['c', EXACT]))).toBe(false);
  });

  it('is not sensitive, though a tuple not known yet holds one inside', () => {
    const tuples = types.tuple([types.tuple([types.string, types.string])]);

    expect(
      isSensitive(
        withSensitive(valueOf(tuples, UNKNOWN), [
          [0, EXACT],
          [EVERY_ITEM, MAYBE],
        ])
      )
    ).toBe(false);
  });

  it('is kept beside a known value that holds the key, since no other item may be there', () => {
    expect(sensitiveUnder(sharedMarks([laterMap([EVERY_ITEM, 'p', MAYBE], ['c', EXACT]), written({ c: { p: 'x' } })]), 'c')).toEqual([]);
  });

  it.each([
    ['that lacks the key', written({ d: { p: 'x' } }), [['p', MAYBE]]],
    ['whose every item may be sensitive', withSensitive(written({ c: { p: 'x' } }), [[EVERY_ITEM, MAYBE]]), [[MAYBE]]],
  ])('is not kept beside a known value %s', (_, known, marks) => {
    expect(sensitiveUnder(sharedMarks([laterMap([EVERY_ITEM, 'p', MAYBE], ['c', EXACT]), known]), 'c')).toEqual(marks);
  });

  it('is not kept where only one of the values has it, beside one that marks every item for certain', () => {
    const exact = laterMap(['k', EXACT], [EVERY_ITEM, MAYBE], ['z']);
    const every = withSensitive(valueOf(types.object({ k: types.string, z: types.string }), UNKNOWN), [[EVERY_ITEM]]);

    expect(sensitiveUnder(sharedMarks([exact, every]), 'k')).toEqual([[MAYBE]]);
  });

  it('is not kept where only one of the values has it', () => {
    expect(sharedMarks([laterMap([EVERY_ITEM, MAYBE], ['c', EXACT]), laterMap([EVERY_ITEM, MAYBE])])).toEqual([[EVERY_ITEM, MAYBE]]);
  });

  it('keeps, where every value has it, what one value has there by a mark for certain under every item', () => {
    const one = laterMap([EVERY_ITEM, 'x'], [EVERY_ITEM, 'y'], [EVERY_ITEM, 'z', MAYBE], ['c', EXACT]);
    const other = laterMap([EVERY_ITEM, 'y'], [EVERY_ITEM, 'z', MAYBE], ['c', EXACT]);

    expect(sensitiveUnder(sharedMarks([one, other]), 'c')).toContainEqual(['x', MAYBE]);
  });

  describe('below a key that is not exact', () => {
    it('is kept where every value has it there', () => {
      const one = below([EVERY_ITEM, MAYBE], ['c', EXACT]);

      expect(sensitiveUnder(sensitiveUnder(sharedMarks([one, one]), 'w'), 'c')).toEqual([]);
    });

    it('is kept where one value has it below every item and the other at the key', () => {
      const every = laterMap([EVERY_ITEM, EVERY_ITEM, MAYBE], [EVERY_ITEM, 'c', EXACT]);
      const keyed = below([EVERY_ITEM, MAYBE], ['c', EXACT]);

      expect(sensitiveUnder(sensitiveUnder(sharedMarks([every, keyed]), 'w'), 'c')).toEqual([]);
    });

    it('is kept where a known value holds the key below one it holds too', () => {
      const marks = sharedMarks([below([EVERY_ITEM, MAYBE], ['c', EXACT]), written({ w: { c: 'x' } })]);

      expect(sensitiveUnder(sensitiveUnder(marks, 'w'), 'c')).toEqual([]);
    });

    it('says nothing below the key is so for certain, since the key may be missing', () => {
      const value = laterMap([EVERY_ITEM, 'k'], ['w', EVERY_ITEM, MAYBE], ['w', 'c', EXACT]);

      expect(sharedMarks([value, value]).filter((path) => holdsFirst(path))).toEqual([]);
    });

    it('is not kept where only one of the values has it there', () => {
      const marks = sharedMarks([below([EVERY_ITEM, MAYBE], ['c', EXACT]), below([EVERY_ITEM, MAYBE])]);

      expect(sensitiveUnder(sensitiveUnder(marks, 'w'), 'c')).toEqual([[MAYBE]]);
    });
  });

  it('is kept under every item where every item has it', () => {
    const item = laterMap([EVERY_ITEM, MAYBE], ['c', EXACT]);

    expect(sensitiveUnder(sensitiveUnder(everyItemMarks([item, item]), 0), 'c')).toEqual([]);
  });

  it('is not kept under every item where one item lacks it', () => {
    const marks = everyItemMarks([laterMap([EVERY_ITEM, MAYBE], ['c', EXACT]), laterMap([EVERY_ITEM, MAYBE])]);

    expect(sensitiveUnder(sensitiveUnder(marks, 0), 'c')).toEqual([[MAYBE]]);
  });

  it('keeps under every item, at the key, what each item has there for certain', () => {
    const item = laterMap([EVERY_ITEM, MAYBE], ['c', EXACT], ['c', 'x']);

    expect(sensitiveUnder(sensitiveUnder(everyItemMarks([item]), 0), 'c')).toEqual([['x']]);
  });

  it('is kept in a value that may be there, with what it may have at the key', () => {
    const marks = maybeMarks([laterMap([EVERY_ITEM, MAYBE], ['c', EXACT], ['c', 'x'])]);

    expect(sensitiveUnder(marks, 'c')).toEqual([['x', MAYBE]]);
  });

  it('is not kept in values that may be there where one lacks it', () => {
    const marks = maybeMarks([laterMap([EVERY_ITEM, MAYBE], ['c', EXACT]), laterMap(['c', 'x'])]);

    expect(sensitiveUnder(marks, 'c')).toEqual([[MAYBE]]);
  });

  it('stays out of what an item the plan cannot name may have', () => {
    expect(
      anyItemMarks([
        [EVERY_ITEM, 'p', MAYBE],
        ['c', EXACT],
      ])
    ).toEqual([['p', MAYBE]]);
  });

  it('leaves a set made of the tuple only as one that may be sensitive', () => {
    const tuple = withSensitive(valueOf(types.tuple([types.string, types.string]), UNKNOWN), [
      [EVERY_ITEM, MAYBE],
      [0, EXACT],
    ]);

    expect(sensitiveAs(tuple, valueOf(types.set(types.string), UNKNOWN)).marks?.paths()).toEqual([[MAYBE]]);
  });

  it('marks a set only as one that may be sensitive, where every item of a list not known yet is', () => {
    const list = withSensitive(valueOf(types.list(types.string), UNKNOWN), [[EVERY_ITEM]]);

    expect(sensitiveAs(list, valueOf(types.set(types.string), UNKNOWN)).marks?.paths()).toEqual([[MAYBE]]);
  });

  it('marks a set as a whole, where every item of a list that holds one is', () => {
    const list = withSensitive(valueOf(types.list(types.string), ['a']), [[EVERY_ITEM]]);

    expect(sensitiveAs(list, valueOf(types.set(types.string), ['a'])).marks?.paths()).toEqual([[]]);
  });

  it('makes no attribute sensitive that the schema marks with the one it is at', () => {
    const schema = { a: { type: types.map(types.string) }, b: { type: types.string, computed: true, sensitiveWith: ['a'] } };

    expect(
      schemaMarked(schema, {
        a: withSensitive(valueOf(types.map(types.string), UNKNOWN), [
          [EVERY_ITEM, MAYBE],
          ['c', EXACT],
        ]),
      })
    ).toEqual({ certain: [], maybe: ['b'] });
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
    expect(child(withSensitive(written({ '-2': UNKNOWN }), [[SOMEWHERE]]), '-2').marks).toBeUndefined();
  });

  it.each([
    ['none, where it is sensitive somewhere', [[SOMEWHERE]], undefined],
    ['only those for certain, where it is sensitive somewhere and at that part', [[SOMEWHERE], ['-2', 'q']], [['q']]],
  ])('are, at a known part of a value, %s, since what is sensitive somewhere lies in a part not known yet', (_, marks, below) => {
    expect(child(withSensitive(written({ a: UNKNOWN, '-2': { q: 'x' } }), marks), '-2').marks?.paths()).toEqual(below);
  });

  it('are maybe at a part of a value that may be sensitive as a whole', () => {
    expect(child(withSensitive(written({ a: UNKNOWN, b: 'x' }), [[SOMEWHERE], [MAYBE]]), 'b').marks?.paths()).toEqual([[MAYBE]]);
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

  describe('of a place after those a for over a known collection keeps for certain', () => {
    const exact = laterMap([EVERY_ITEM, MAYBE], ['c', EXACT]);
    const other = laterMap([EVERY_ITEM, MAYBE]);

    it('keep a key every item from there on holds exactly', () => {
      expect(cAt(pickedTupleMarks([written('x'), exact], [true, false]), 1)).toEqual([]);
    });

    it('keep it where only an item before the place lacks it', () => {
      expect(cAt(pickedTupleMarks([written('x'), other, exact], [true, false, false]), 2)).toEqual([]);
    });

    it('do not keep it where an item from there on lacks it', () => {
      expect(cAt(pickedTupleMarks([written('x'), other, exact], [true, false, false]), 1)).toEqual([[MAYBE]]);
    });

    it('leave a place kept for certain only its own', () => {
      expect(sensitiveUnder(pickedTupleMarks([marked(), marked(['b'])], [true, false]), 0)).toEqual([]);
    });

    it('give a place after them only what its items may have, since it may not be there', () => {
      expect(sensitiveUnder(pickedTupleMarks([marked(), marked(['b'])], [true, false]), 1)).toEqual([['b', MAYBE]]);
    });
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
