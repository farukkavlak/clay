import { ExactNumber, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { offApply } from '../src/index';

describe('what an apply returned, held to the plan', () => {
  it('takes anything where the plan did not know the value', () => {
    expect(offApply({ stdout: UNKNOWN }, {}, { stdout: 'one\n' })).toEqual([]);
  });

  it('takes a value the plan did not know coming back as nothing', () => {
    expect(offApply({ stdout: UNKNOWN }, {}, {})).toEqual([]);
  });

  it('names where a known value in a list differs, and passes the item the plan did not know', () => {
    expect(offApply({ l: ['a', UNKNOWN, 'c'] }, {}, { l: ['a', 'anything', 'x'] })).toEqual([{ path: ['l', 2], planned: 'c', returned: 'x' }]);
  });

  it('names a map whose keys differ at the map', () => {
    expect(offApply({ tags: { a: UNKNOWN } }, {}, { tags: { a: '1', b: '2' } })).toEqual([{ path: ['tags'], planned: { a: UNKNOWN }, returned: { a: '1', b: '2' } }]);
  });

  it('names a value the plan did not have', () => {
    expect(offApply({}, {}, { special: null })).toEqual([{ path: ['special'], planned: undefined, returned: null }]);
  });

  it('names a value the plan had and the apply did not return', () => {
    expect(offApply({ content: 'a' }, {}, {})).toEqual([{ path: ['content'], planned: 'a', returned: undefined }]);
  });

  it('holds a value the configuration sets and the plan did not know to what it resolved to', () => {
    expect(offApply({ content: UNKNOWN }, { content: 'a' }, { content: 'b' })).toEqual([{ path: ['content'], planned: 'a', returned: 'b' }]);
  });

  it('names a value returned not known, even where the plan did not know it', () => {
    expect(offApply({ tags: { a: UNKNOWN } }, {}, { tags: { a: UNKNOWN } })).toEqual([{ path: ['tags', 'a'], planned: UNKNOWN, returned: UNKNOWN }]);
  });

  it('names every value not known inside one returned', () => {
    expect(offApply({ tags: UNKNOWN }, {}, { tags: { a: UNKNOWN, b: UNKNOWN } }).map(({ path }) => path)).toEqual([
      ['tags', 'a'],
      ['tags', 'b'],
    ]);
  });

  it('names a value the plan had and the apply did not return as missing, whatever its name', () => {
    expect(offApply({ constructor: 'x' }, {}, {})).toEqual([{ path: ['constructor'], planned: 'x', returned: undefined }]);
  });

  it('names a value returned not known with what the plan showed there', () => {
    expect(offApply({ tags: { a: '1' } }, {}, { tags: { a: UNKNOWN } })).toEqual([{ path: ['tags', 'a'], planned: '1', returned: UNKNOWN }]);
  });

  it('tells a number a provider made in JavaScript from the exact one the plan has', () => {
    expect(offApply({ length: ExactNumber.parse('5') }, {}, { length: 5 })).toEqual([{ path: ['length'], planned: ExactNumber.parse('5'), returned: 5 }]);
  });

  it('names every value that differs, not only the first', () => {
    expect(offApply({ a: '1', b: '2' }, {}, { a: 'x', b: 'y' }).map(({ path }) => path)).toEqual([['a'], ['b']]);
  });

  it('names every place inside one value that differs', () => {
    expect(offApply({ l: ['a', 'b'], tags: { x: '1', y: '2' } }, {}, { l: ['p', 'q'], tags: { x: '3', y: '4' } }).map(({ path }) => path)).toEqual([
      ['l', 0],
      ['l', 1],
      ['tags', 'x'],
      ['tags', 'y'],
    ]);
  });

  // Every object answers to `constructor`, so the plan has to hold the name itself to have planned it.
  it('names a value the plan did not have, whatever its name', () => {
    expect(offApply({}, {}, { constructor: 'x' })).toEqual([{ path: ['constructor'], planned: undefined, returned: 'x' }]);
  });

  it('takes what the plan showed', () => {
    expect(offApply({ tags: { a: '1', b: '2' } }, {}, { tags: { b: '2', a: '1' } })).toEqual([]);
  });
});
