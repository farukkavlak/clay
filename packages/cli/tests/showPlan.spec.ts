import { Marks, MAYBE, types, UNKNOWN } from '@clay/contracts';
import { Plan } from '@clay/planner';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { displayPlan, show } from '../src/showPlan';

const members = types.set(types.string);

/** What the CLI prints for a plan that changes only one output. */
function shown(old: unknown, next: unknown): string[] {
  const plan: Plan = {
    serial: 0,
    actions: [],
    outputs: { m: { old: { value: old, type: members }, new: { value: next, type: members } } },
    prevRun: {},
    prior: {},
    schemas: {},
    dataSources: {},
    readAtApply: [],
  };
  const printed: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => printed.push(stripVTControlCharacters(args.join(' '))));

  displayPlan(plan);

  return printed;
}

describe('showing a set output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows one not known yet whole, having no members to compare', () => {
    expect(shown(['a'], UNKNOWN)).toContain('  ~ m = ["a"] -> (known after apply)');
  });

  it('shows a member not known yet as one it gains', () => {
    expect(shown(['a', 'b'], ['a', UNKNOWN])).toEqual(expect.arrayContaining(['  ~ m:', '      - "b"', '      + (known after apply)', '      (1 unchanged)']));
  });
});

describe('showing a sensitive set attribute', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hides it whole, members and all', () => {
    const plan: Plan = {
      serial: 0,
      actions: [
        {
          type: 'UPDATE',
          resourceType: 'x',
          name: 'a',
          planned: {},
          after: { tags: ['b'] },
          sensitive: [['tags']],
          changes: { tags: { old: ['a'], new: ['b'] } },
        },
      ],
      outputs: {},
      prevRun: {},
      prior: { 'x.a': { resourceType: 'x', name: 'a', attributes: { tags: ['a'] }, sensitive: [['tags']] } },
      schemas: { x: { tags: { type: members } } },
      dataSources: {},
      readAtApply: [],
    };
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => printed.push(stripVTControlCharacters(args.join(' '))));

    displayPlan(plan);

    expect(printed).toContain('      tags: (sensitive value) -> (sensitive value)');
    expect(printed.join('\n')).not.toMatch(/"a"|"b"/);
  });
});

describe('showing an attribute whose name a configuration cannot write bare', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('quotes the name and escapes a control character in it, in a change, a set change and a change of marks', () => {
    const plan: Plan = {
      serial: 0,
      actions: [
        { type: 'UPDATE', resourceType: 'x', name: 'a', planned: {}, after: {}, changes: { ['b\u007F']: { old: 'c', new: 'd' } } },
        { type: 'UPDATE', resourceType: 'x', name: 'b', planned: {}, after: {}, changes: { ['s\u007F']: { old: ['c'], new: ['d'] } } },
        { type: 'UPDATE', resourceType: 'x', name: 'c', planned: {}, after: {}, sensitive: [['m\u007F']], changes: {} },
      ],
      outputs: {},
      prevRun: {},
      prior: {},
      schemas: { x: { ['s\u007F']: { type: members } } },
      dataSources: {},
      readAtApply: [],
    };
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => printed.push(stripVTControlCharacters(args.join(' '))));

    displayPlan(plan);

    expect(printed).toContain(String.raw`      "b\u007f": "c" -> "d"`);
    expect(printed).toContain(String.raw`      "s\u007f":`);
    expect(printed).toContain(String.raw`      "m\u007f": will be marked sensitive`);
  });
});

describe('a value that may be sensitive, as the plan shows it', () => {
  it.each([
    ['hides a known one', 'x', '(sensitive value)'],
    ['says one not known yet is known after apply', UNKNOWN, '(known after apply)'],
  ])('%s', (_, value, shown) => {
    expect(show(value, Marks.of([[MAYBE]]))).toBe(shown);
  });
});
