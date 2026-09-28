import { parseReference, ResourceReference } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { checkInRange } from '../../src/resolvers/instance';

const reference = parseReference(['local_file', 'logs', 0, 'id']) as ResourceReference;

describe('an index checked against a count', () => {
  it.each([
    [0, 'local_file.logs has no instances: its count is 0'],
    [1, 'local_file.logs has 1 instance, [0]'],
    [3, 'local_file.logs has 3 instances, [0] to [2]'],
  ])('says what a count of %i makes when the index is past it', (count, message) => {
    expect(() => checkInRange(reference, count, count)).toThrow(message);
  });

  it('takes an index below the count, and any index while the count is not read yet', () => {
    expect(() => checkInRange(reference, 2, 3)).not.toThrow();
    expect(() => checkInRange(reference, 7, undefined)).not.toThrow();
  });
});
