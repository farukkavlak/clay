import { types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { converted } from '../src/conformValues';
import { readPath } from '../src/resolvers/readPath';
import { allSensitive, child, inferred, objectOf, tupleOf, Value, valueOf, withSensitive } from '../src/Value';
import { steps } from './ast';

const at = { file: 'main.clay', line: 1, column: 1 };

/** As the configuration writes it: a list is a tuple and a map an object. */
const written = (data: unknown): Value => valueOf(inferred(data), data);

const secret = allSensitive(valueOf(types.string, 's3cret'));

describe('the sensitive parts of a value', () => {
  it('are left out where it has none, so it is the value it was', () => {
    expect(withSensitive(written('a'), [])).toEqual({ type: types.string, data: 'a' });
    expect(tupleOf([written('a')])).not.toHaveProperty('sensitive');
  });

  it('are the whole value where the whole is among them', () => {
    expect(withSensitive(written({ a: 'x' }), [['a'], []]).sensitive).toEqual([[]]);
  });

  it('are kept by the step to each, in a tuple and an object made of values', () => {
    const conn = objectOf([
      ['name', written('app')],
      ['password', secret],
    ]);

    expect(conn.sensitive).toEqual([['password']]);
    expect(tupleOf([written('a'), conn]).sensitive).toEqual([[1, 'password']]);
  });

  it('follow a step into the value: the part reached is sensitive, another is not', () => {
    const list = tupleOf([written('a'), objectOf([['password', secret]])]);

    expect(child(list, 0)).not.toHaveProperty('sensitive');
    expect(child(list, 1).sensitive).toEqual([['password']]);
    expect(child(child(list, 1), 'password').sensitive).toEqual([[]]);
  });

  it('are every part of a value that is sensitive as a whole', () => {
    expect(child(allSensitive(written(['a'])), 0).sensitive).toEqual([[]]);
  });

  it('stay where they were in a list or a map the value is given as', () => {
    const list = tupleOf([written('a'), secret]);
    const conn = objectOf([['password', secret]]);

    expect(converted('v', list, types.list(types.string), ['v']).sensitive).toEqual([[1]]);
    expect(converted('v', conn, types.map(types.string), ['v']).sensitive).toEqual([['password']]);
    expect(converted('v', conn, types.dynamic, ['v']).sensitive).toEqual([['password']]);
  });

  // A set is sorted and holds each member once, so where a member sits and how many there are give it away.
  it('are the whole set where a member is one, however deep the set is', () => {
    const members = tupleOf([written('b'), secret]);

    expect(converted('v', members, types.set(types.string), ['v']).sensitive).toEqual([[]]);
    expect(converted('v', objectOf([['ids', members]]), types.object({ ids: types.set(types.string) }), ['v']).sensitive).toEqual([['ids']]);
  });

  it('travel with a value not known yet, to the part a reference reads', () => {
    const later = withSensitive(valueOf(types.object({ name: types.string, password: types.string }), UNKNOWN), [['password']]);

    expect(() => readPath(later, 'local.conn', steps('password'), at)).toThrow(expect.objectContaining({ type: types.string, sensitive: [[]] }));
    expect(() => readPath(later, 'local.conn', steps('name'), at)).toThrow(expect.objectContaining({ type: types.string, sensitive: [] }));
  });
});
