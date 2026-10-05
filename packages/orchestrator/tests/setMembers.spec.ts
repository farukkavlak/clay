import { ExactNumber, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { setOf } from '../src/setMembers';

const n = (text: string) => ExactNumber.parse(text);

describe('the members of a set', () => {
  it('holds them in one order, however they were written', () => {
    expect(setOf(['b', 'c', 'a'])).toEqual(setOf(['c', 'a', 'b']));
  });

  it('orders numbers by their value', () => {
    expect(setOf([n('443'), n('-1'), n('80'), n('0.5')])).toEqual([n('-1'), n('0.5'), n('80'), n('443')]);
  });

  it('holds a member written twice once', () => {
    expect(setOf(['a', 'b', 'a'])).toEqual(['a', 'b']);
  });

  it('holds two maps with the same keys and values as one member, whatever order their keys are in', () => {
    expect(
      setOf([
        { a: '1', b: '2' },
        { b: '2', a: '1' },
      ])
    ).toEqual([{ a: '1', b: '2' }]);
  });

  it('tells a string from the number or the boolean it spells', () => {
    expect(setOf([true, n('1'), 'true', '#1'])).toEqual(['#1', 'true', n('1'), true]);
  });

  it('tells a list from one whose items would join into the same text', () => {
    expect(setOf([[['a'], ['b']], [['a', 'b']]])).toEqual([[['a', 'b']], [['a'], ['b']]]);
  });

  it('tells a map from one whose keys would join into the same text', () => {
    const joined = { 'a:"x",b': '1' };

    expect(setOf([{ a: 'x', b: '1' }, joined])).toEqual(expect.arrayContaining([{ a: 'x', b: '1' }, joined]));
  });

  it('holds null once, after the members that are values', () => {
    expect(setOf([null, 'b', null, 'a'])).toEqual(['a', 'b', null]);
  });

  // Each may become any value, including another member's, so none is merged.
  it('keeps every member not known yet, after the rest', () => {
    const partly = { id: UNKNOWN };

    expect(setOf([partly, 'b', UNKNOWN, null, UNKNOWN, 'a'])).toEqual(['a', 'b', null, UNKNOWN, UNKNOWN, partly]);
  });

  // A provider may return them in another order, and they are compared as stored.
  it('holds members known in part in one order, by what is known of them, and each of them', () => {
    const z = ['z', UNKNOWN];
    const a = ['a', UNKNOWN];

    expect(setOf([z, a, z])).toEqual([a, z, z]);
    expect(setOf([a, z, z])).toEqual([a, z, z]);
  });
});
