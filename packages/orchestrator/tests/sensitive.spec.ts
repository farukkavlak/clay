import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
import { ConfigError } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { converted, SchemaMismatch } from '../src/conformValues';
import { declaredAs, givenTo } from '../src/declared';
import { forObject } from '../src/forItems';
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

const FIT = 'does not fit what thing takes; it is sensitive, so its parts are not shown';

const keyed = allSensitive(written({ s3cret: 'x' }));

const conn = objectOf([
  ['enabled', written('yes')],
  ['password', secret],
]);

describe('an error about a value with a sensitive part', () => {
  it.each([
    ['a sensitive string that is no boolean', secret, types.bool, 'v: (sensitive value) is not a boolean, which is "true" or "false"'],
    ['a sensitive string that is no number', secret, types.number, 'v: (sensitive value) is not a number'],
    [
      'a sensitive string that spells a number out of range',
      allSensitive(written('1e2000')),
      types.number,
      'v: (sensitive value) is out of range: a number reaches at most 1000 places either side of the point',
    ],
    ['the sensitive part of an object', conn, types.object({ enabled: types.string, password: types.number }), 'v["password"]: (sensitive value) is not a number'],
    ['a name its type does not have, in an object sensitive as a whole', keyed, types.object({ a: types.string }), `v ${FIT}`],
    ['a string that is no boolean under a key of a map sensitive as a whole', keyed, types.map(types.bool), `v ${FIT}`],
    ['a string where a list is taken, under a key of a map sensitive as a whole', keyed, types.map(types.list(types.string)), `v ${FIT}`],
    ['more items than its tuple takes, in a list sensitive as a whole', allSensitive(written(['a', 'b'])), types.tuple([types.string]), `v ${FIT}`],
    ['an object sensitive as a whole inside one that is not', objectOf([['conn', keyed]]), types.object({ conn: types.map(types.bool) }), `v["conn"] ${FIT}`],
  ])('shows nothing of it, for %s', (_, value, type, message) => {
    expect(() => converted('thing', value, type, ['v'])).toThrow(new SchemaMismatch(message, 'v'));
  });

  it('still quotes a part that is not sensitive, beside one that is', () => {
    const type = types.object({ enabled: types.bool, password: types.string });

    expect(() => converted('thing', conn, type, ['v'])).toThrow(new SchemaMismatch('v["enabled"]: "yes" is not a boolean, which is "true" or "false"', 'v'));
  });

  it.each([
    ['both', secret, secret],
    ['the first', secret, written('s3cret')],
    ['the second', written('s3cret'), secret],
  ])('does not quote a key two items of a for give, where %s is sensitive', (_, first, second) => {
    const one = written(ExactNumber.parse('1'));
    const entries: [Value, Value][] = [
      [first, one],
      [second, one],
    ];

    expect(() => forObject(entries, false, false, at)).toThrow(new ConfigError('Two items give the key (sensitive value); write "..." after the value to group them', at));
  });

  it('does not name the keys of items that share no type, where a part is sensitive', () => {
    const items = tupleOf([written({ a: 'x' }), keyed]);

    expect(() => declaredAs('variable', 'v', items, types.list(types.dynamic))).toThrow(
      new SchemaMismatch('variable "v" cannot join what it holds into one type; a part of it is sensitive, so no more is shown', 'v')
    );
  });

  it('does not name a key on the way to a set member that does not fit, in a map sensitive as a whole', () => {
    const member = types.object({ a: types.bool }, ['a']);
    const sets = allSensitive(valueOf(types.object({ s3cret: types.set(types.object({ a: types.string })) }), { s3cret: [{ a: 'yes' }] }));

    expect(() => declaredAs('variable', 'v', sets, types.map(types.set(member)))).toThrow(
      new SchemaMismatch('v does not fit what variable "v" takes; it is sensitive, so its parts are not shown', 'v')
    );
  });

  it('does not say how many items a list sensitive as a whole holds', () => {
    expect(() => readPath(allSensitive(written(['a'])), 'local.list', [{ key: 5 }], at)).toThrow(new ConfigError('local.list has no item [5]', at));
    expect(() => readPath(tupleOf([written('a'), secret]), 'local.list', [{ key: 5 }], at)).toThrow(new ConfigError('local.list has no item [5]: it holds 2', at));
  });

  it('shows nothing of what a block marked sensitive is given, though the value itself is not marked', () => {
    const declared = { type: types.number, sensitive: true as const };

    expect(() => givenTo('output', 'password', written('s3cret'), declared, () => secret)).toThrow(new SchemaMismatch('password: (sensitive value) is not a number', 'password'));
  });
});
