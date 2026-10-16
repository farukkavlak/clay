import { describe, expect, it } from 'vitest';

import { touchesSensitive } from '../src';

describe('touchesSensitive', () => {
  const marks = [
    ['triggers', 'token'],
    ['list', 1],
    ['whole', 'inner'],
  ];

  it.each([
    ['a marked part', ['triggers', 'token']],
    ['a part inside a marked part', ['list', 1, 'deeper']],
    ['a value holding a marked part', ['triggers']],
    ['an index spelled as text', ['list', '1']],
  ])('takes %s', (_, at) => {
    expect(touchesSensitive(marks, at)).toBe(true);
  });

  it.each([
    ['a sibling of a marked part', ['triggers', 'name']],
    ['another index', ['list', 0]],
    ['a name nothing marks', ['plain']],
  ])('leaves out %s', (_, at) => {
    expect(touchesSensitive(marks, at)).toBe(false);
  });

  it('takes every path of a value marked as a whole', () => {
    expect(touchesSensitive([[]], ['anything', 2])).toBe(true);
  });

  it('takes no path when nothing is marked', () => {
    expect(touchesSensitive([], ['triggers'])).toBe(false);
  });
});
