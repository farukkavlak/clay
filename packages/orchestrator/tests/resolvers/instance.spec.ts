import { parseReference, ResourceReference } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { checkHasKey, checkInRange, readInstance } from '../../src/resolvers/instance';

const reference = parseReference(['local_file', 'logs', 0, 'id']) as ResourceReference;
const keyed = (...path: (string | number)[]) => parseReference(['local_file', 'logs', ...path]) as ResourceReference;

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

describe('a key checked against a for_each', () => {
  it.each([
    [[], 'local_file.logs has no instances: its for_each is empty'],
    [['a'], 'local_file.logs has no instance ["x"], only ["a"]'],
    [['a', 'b c'], 'local_file.logs has no instance ["x"], only ["a"], ["b c"]'],
  ])('says what a for_each of %j makes when the key is not one of them', (keys, message) => {
    expect(() => checkHasKey(keyed('x', 'id'), 'x', keys)).toThrow(message);
  });

  it('takes a key the for_each gives, and any key while the for_each is not read yet', () => {
    expect(() => checkHasKey(keyed('a', 'id'), 'a', ['a'])).not.toThrow();
    expect(() => checkHasKey(keyed('x', 'id'), 'x', undefined)).not.toThrow();
  });
});

describe('an instance of a resource with for_each read by a reference', () => {
  // `.web` and `["web"]` are one step, so both name the instance.
  it('reads the first step as the key, the next as the attribute and the rest as the path', () => {
    expect(readInstance(keyed('web', 'tags', 'env'), 'for_each')).toEqual({ key: 'web', attribute: 'tags', path: ['env'] });
    expect(readInstance(keyed('a.b', 'id'), 'for_each')).toEqual({ key: 'a.b', attribute: 'id', path: [] });
  });

  it.each([
    [[0, 'id'], 'local_file.logs has for_each, so name one of it by key, as in local_file.logs["key"]'],
    [['content'], 'Reference "local_file.logs.content" names an instance and no attribute: local_file.logs has for_each, so its key comes first, as in local_file.logs["key"].id'],
    [['web', 0], 'Reference "local_file.logs.web[0]" has an index where it needs a name'],
  ])('refuses %j', (path, message) => {
    expect(() => readInstance(keyed(...path), 'for_each')).toThrow(message);
  });
});
