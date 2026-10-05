import { parseReference, ResourceReference } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { checkHasKey, checkInRange, readInstance } from '../../src/resolvers/instance';

const keyed = (...path: (string | number)[]) => parseReference(['local_file', 'logs', ...path]) as ResourceReference;

describe('an index checked against a count', () => {
  it.each([
    [0, 'local_file.logs has no instances: its count is 0'],
    [1, 'local_file.logs has 1 instance, [0]'],
    [3, 'local_file.logs has 3 instances, [0] to [2]'],
  ])('says what a count of %i makes when the index is past it', (count, message) => {
    expect(() => checkInRange('local_file.logs', count, count)).toThrow(message);
  });

  it('takes an index below the count, and any index while the count is not read yet', () => {
    expect(() => checkInRange('local_file.logs', 2, 3)).not.toThrow();
    expect(() => checkInRange('local_file.logs', 7, undefined)).not.toThrow();
  });
});

describe('a key checked against a for_each', () => {
  it.each([
    [[], 'local_file.logs has no instances: its for_each is empty'],
    [['a'], 'local_file.logs has no instance ["x"], only ["a"]'],
    [['a', 'b c'], 'local_file.logs has no instance ["x"], only ["a"], ["b c"]'],
  ])('says what a for_each of %j makes when the key is not one of them', (keys, message) => {
    expect(() => checkHasKey('local_file.logs', 'x', keys)).toThrow(message);
  });

  it('takes a key the for_each gives, and any key while the for_each is not read yet', () => {
    expect(() => checkHasKey('local_file.logs', 'a', ['a'])).not.toThrow();
    expect(() => checkHasKey('local_file.logs', 'x', undefined)).not.toThrow();
  });
});

describe('an instance of a resource with for_each read by a reference', () => {
  // `.web` and `["web"]` are the same step, so both name the instance.
  it('reads the first step as the key, the next as the attribute and the rest as the path', () => {
    expect(readInstance(keyed('web', 'tags', 'env'), 'for_each')).toEqual({ key: 'web', attribute: 'tags', path: ['env'] });
    expect(readInstance(keyed('a.b', 'id'), 'for_each')).toEqual({ key: 'a.b', attribute: 'id', path: [] });
  });

  it('reads a key with nothing after it as the whole instance', () => {
    expect(readInstance(keyed('content'), 'for_each')).toEqual({ key: 'content', attribute: undefined, path: [] });
  });

  it.each([
    [[0, 'id'], 'local_file.logs has for_each, so name one of it by key, as in local_file.logs["key"]'],
    [[], 'local_file.logs has for_each, so name one of it by key, as in local_file.logs["key"]'],
    [['web', 0], 'Reference "local_file.logs.web[0]" has an index where it needs a name'],
  ])('refuses %j', (path, message) => {
    expect(() => readInstance(keyed(...path), 'for_each')).toThrow(message);
  });
});

describe('a whole instance read by a reference', () => {
  it('reads an index with nothing after it as the whole instance', () => {
    expect(readInstance(keyed(1), 'count')).toEqual({ key: 1, attribute: undefined, path: [] });
  });

  it('reads the name alone as the whole instance of a resource with no count or for_each', () => {
    expect(readInstance(keyed(), undefined)).toEqual({ attribute: undefined, path: [] });
  });

  it.each([
    ['count', [], 'local_file.logs has count, so name one of it by index, as in local_file.logs[0]'],
    [undefined, [0], 'local_file.logs has no count, so it takes no index'],
    ['count', [0, 1], 'Reference "local_file.logs[0][1]" has an index where it needs a name'],
  ] as const)('refuses, with %s, the steps %j', (repetition, path, message) => {
    expect(() => readInstance(keyed(...path), repetition)).toThrow(message);
  });
});
