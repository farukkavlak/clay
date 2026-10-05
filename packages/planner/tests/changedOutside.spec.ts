import { Resource } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { changedOutside, Plan } from '../src/index';

const file = (content: string): Resource => ({ resourceType: 'local_file', name: 'a', attributes: { path: 'a.txt', content } });
const planOf = (prevRun: Plan['prevRun'], prior: Plan['prior']): Plan => ({ serial: 0, actions: [], outputs: {}, prevRun, prior, schemas: {}, dataSources: {} });

describe('what changed outside Clay', () => {
  it('names a resource the refresh did not find', () => {
    expect(changedOutside(planOf({ 'local_file.a': file('hi') }, {}))).toEqual([{ address: 'local_file.a' }]);
  });

  it('names a resource the refresh read otherwise, with what changed', () => {
    expect(changedOutside(planOf({ 'local_file.a': file('hi') }, { 'local_file.a': file('edited') }))).toEqual([
      { address: 'local_file.a', changes: { content: { old: 'hi', new: 'edited' } } },
    ]);
  });

  it('names nothing for a resource read as state held it', () => {
    expect(changedOutside(planOf({ 'local_file.a': file('hi') }, { 'local_file.a': file('hi') }))).toEqual([]);
  });
});
