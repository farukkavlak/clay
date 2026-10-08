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
