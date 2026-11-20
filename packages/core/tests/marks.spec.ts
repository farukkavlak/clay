import { describe, expect, it } from 'vitest';

import { AttributePath, EVERY_ITEM, EXACT, MAYBE, SOMEWHERE } from '../src';
import { Marks } from '../src/marks';
import { sensitiveUnderAsWas } from './sensitiveUnderAsWas';

const STEPS = ['a', 'b', '1', '-1', 0, 1, EVERY_ITEM, EVERY_ITEM, SOMEWHERE, MAYBE, EXACT];
const ENDS = [undefined, undefined, SOMEWHERE, MAYBE, MAYBE, EXACT];

/** The same numbers on every run, so a failure can be run again. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const pick = <T>(random: () => number, from: readonly T[]): T => from[Math.floor(random() * from.length)];

function randomPath(random: () => number): AttributePath {
  const steps = Array.from({ length: Math.floor(random() * 4) }, () => pick(random, STEPS));
  const end = pick(random, ENDS);
  return end === undefined ? steps : [...steps, end];
}

/** Whether `paths` hold `path` itself. */
const holds = (paths: AttributePath[], path: AttributePath) => paths.some((each) => each.length === path.length && each.every((step, index) => step === path[index]));

describe('marks held by their steps', () => {
  it('leave under each step what the paths did, in their order, however deep', () => {
    const random = seeded(7);
    for (let run = 0; run < 5000; run++) {
      const paths = Array.from({ length: 1 + Math.floor(random() * 8) }, () => randomPath(random));
      const steps = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(random, [...STEPS, 'c', 2, '-4']));

      const asWas = steps.reduce((marks, step) => sensitiveUnderAsWas(marks, step), paths);
      const held = steps.reduce((marks, step) => marks.under(step), Marks.of(paths)).paths();

      expect({ paths, steps, held }).toEqual({ paths, steps, held: asWas });
    }
  });

  it('say whether the whole is sensitive, may be, or is somewhere, as their paths do, however deep', () => {
    const random = seeded(11);
    for (let run = 0; run < 5000; run++) {
      const paths = Array.from({ length: 1 + Math.floor(random() * 8) }, () => randomPath(random));
      const steps = Array.from({ length: Math.floor(random() * 4) }, () => pick(random, [...STEPS, 'c', 2, '-4']));

      const marks = steps.reduce((held, step) => held.under(step), Marks.of(paths));
      const said = { whole: marks.whole(), maybe: marks.maybeWhole(), somewhere: marks.somewhere() };
      const read = marks.paths();

      expect({ paths, steps, said }).toEqual({ paths, steps, said: { whole: holds(read, []), maybe: holds(read, [MAYBE]), somewhere: holds(read, [SOMEWHERE]) } });
    }
  });

  it('say the whole is sensitive where the mark of every item is, under a key spelled as a marker', () => {
    const paths: AttributePath[] = [['-1', 'x'], [EVERY_ITEM]];

    expect(Marks.of(paths).under('-1').whole()).toBe(true);
  });

  it('say the whole may not be sensitive under a key held exactly', () => {
    const paths: AttributePath[] = [
      [EVERY_ITEM, MAYBE],
      ['k', EXACT],
    ];

    expect(Marks.of(paths).under('k').maybeWhole()).toBe(false);
  });

  it('read as the paths they were given, twice and in their order', () => {
    const paths: AttributePath[] = [['b'], [EVERY_ITEM, MAYBE], ['a', EXACT], ['b'], [1], ['1'], [EXACT]];

    expect(Marks.of(paths).paths()).toEqual(paths);
  });

  it('keep under a key spelled as a marker the marks of that key and of every item', () => {
    const paths: AttributePath[] = [['-1', 'x'], [EVERY_ITEM, 'y'], [SOMEWHERE]];

    expect(Marks.of(paths).under(EVERY_ITEM).paths()).toEqual([['x'], ['y']]);
  });

  it('keep out of a key held exactly, at every depth, a mark that may be so under every item', () => {
    const paths: AttributePath[] = [
      [EVERY_ITEM, 'x', MAYBE],
      [EVERY_ITEM, 'y'],
      ['k', EXACT],
    ];

    expect(Marks.of(paths).under('k').paths()).toEqual([['y']]);
  });

  it('keep that mark out of every step below the key held exactly', () => {
    const paths: AttributePath[] = [
      [EVERY_ITEM, MAYBE],
      ['k', EXACT],
    ];

    expect(Marks.of(paths).under('k').under('x').paths()).toEqual([]);
  });

  it('hold no key spelled as a marker exactly where every item is asked for', () => {
    const paths: AttributePath[] = [
      [EVERY_ITEM, MAYBE],
      ['-1', EXACT],
    ];

    expect(Marks.of(paths).under(EVERY_ITEM).paths()).toEqual([[MAYBE]]);
  });
});
