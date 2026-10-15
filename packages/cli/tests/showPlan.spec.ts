import { types, UNKNOWN } from '@clay/contracts';
import { Plan } from '@clay/planner';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { displayPlan } from '../src/showPlan';

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
