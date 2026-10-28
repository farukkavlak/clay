import { UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { growth, LINEAR } from '../../../tests/growth';
import { parsePlanFile, Plan, serializePlan } from '../src/index';

const emptyPlan: Plan = { serial: 0, actions: [], outputs: {}, prevRun: {}, prior: {}, schemas: { x: {} }, dataSources: {}, readAtApply: [] };

/** A plan file whose one change holds `size` values not known yet. */
const unknownMembers = (size: number) => {
  const members = Array.from({ length: size }, () => UNKNOWN);
  return serializePlan(
    { ...emptyPlan, actions: [{ type: 'UPDATE', resourceType: 'x', name: 'a', planned: {}, after: {}, changes: { members: { old: [], new: members } } }] },
    { 'main.clay': '' }
  );
};

/** Milliseconds reading `content` takes. */
const readTime = (content: string) => {
  const started = performance.now();
  parsePlanFile(content, 'tfplan.json');
  return performance.now() - started;
};

describe('reading a plan file', () => {
  it('reads a change with many values not known yet in time that grows with them', async () => {
    expect(await growth(4000, (size) => readTime(unknownMembers(size)))).toBeLessThan(LINEAR);
  });
});
