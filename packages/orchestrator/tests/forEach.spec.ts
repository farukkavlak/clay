import { ExactNumber } from '@clay/contracts';
import { UNKNOWN } from '@clay/planner';
import { describe, expect, it } from 'vitest';

import { eachFrom } from '../src/forEach';

describe('the instances a for_each makes', () => {
  it('makes one for each key of a map, given its value', () => {
    const port = ExactNumber.parse('80');

    expect([...eachFrom({ web: port, api: 'x' })]).toEqual([
      ['api', 'x'],
      ['web', port],
    ]);
  });

  it('makes one for each string of a list, given the string as its value', () => {
    expect([...eachFrom(['b', 'a'])]).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ]);
  });

  // An object lists a key like "1" first whatever order it was written in, so only a sort gives one order for both.
  it('orders the keys by their characters, whatever order they are written in', () => {
    expect([...eachFrom({ b: 1, 10: 2, a: 3, 9: 4 }).keys()]).toEqual(['10', '9', 'a', 'b']);
    expect([...eachFrom(['b', '10', 'a', '9']).keys()]).toEqual(['10', '9', 'a', 'b']);
  });

  it('makes none from an empty map or list', () => {
    expect(eachFrom({}).size).toBe(0);
    expect(eachFrom([]).size).toBe(0);
  });

  it('takes an empty string as a key', () => {
    expect([...eachFrom([''])]).toEqual([['', '']]);
  });

  it.each([
    ['a value only an apply makes', UNKNOWN, 'for_each must be known when planning: it reads a value only an apply makes'],
    ['a string', 'a', 'for_each is a map or a list of strings, not a string'],
    ['a number', ExactNumber.parse('2'), 'for_each is a map or a list of strings, not a number'],
    ['a bool', true, 'for_each is a map or a list of strings, not a bool'],
    ['a list with a number in it', ['a', ExactNumber.parse('1')], 'for_each is a list of strings, but item [1] is a number'],
    ['a list with a list in it', [['a']], 'for_each is a list of strings, but item [0] is a list'],
    ['a list with a string twice', ['a', 'b', 'a'], 'for_each holds "a" twice; each instance needs a key of its own'],
  ])('refuses %s', (_, value, message) => {
    expect(() => eachFrom(value)).toThrow(message);
  });
});
