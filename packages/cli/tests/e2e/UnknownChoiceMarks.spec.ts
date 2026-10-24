import { types, UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

// Not known at plan, and false once the string is made.
const LATER = 'length(random_string.s.result) == 5';

const output = (value: string, list = '[]', over = '[]') =>
  `resource "random_string" "s" { length = 4 }\nlocals {\n  l = ${list}\n  m = ${over}\n}\noutput "o" {\n  value = ${value}\n}`;

// Read at the index the string's length gives once made: 1.
const AT = 'local.l[length(random_string.s.result) - 3]';

const REFUSED = 'output "o" holds a sensitive value; write sensitive = true to export it';

const MAYBE_REFUSED = 'output "o" may hold a sensitive value, by what the apply finds; write sensitive = true to export it';

// A choice not known at plan gives a value not known either: a mark on only one side leaves `issensitive` to the apply, and a root output that may hold it is refused at plan.
describe('a value a choice not known at plan makes', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const outputs = async () => {
    const state = await new LocalBackend(dir).read();
    return Object.fromEntries(Object.entries(state.outputs ?? {}).map(([name, { value }]) => [name, value]));
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-unknown-choice-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['issensitive of a condition', `issensitive(${LATER} ? sensitive("a") : "b")`, false],
    ['issensitive of && its sensitive right side decides', `issensitive(${LATER} && sensitive(false))`, false],
    ['issensitive of && its sensitive left side decides', `issensitive(sensitive(${LATER}) && false)`, true],
    ['issensitive of || its sensitive right side decides', `issensitive(${LATER} || sensitive(true))`, true],
    ['issensitive of && with a known sensitive left side and a right side that decides', `issensitive(sensitive(true) && ${LATER})`, false],
    ['issensitive of && with only its left side sensitive, both not known', `issensitive(sensitive(length(random_string.s.result) == 4) && ${LATER})`, false],
    ['issensitive of || with a known sensitive left side and a right side that decides', `issensitive(sensitive(false) || !(${LATER}))`, false],
    ['issensitive of || with only its left side sensitive, both not known', `issensitive(sensitive(${LATER}) || !(${LATER}))`, false],
    ['issensitive of lookup with a key not known yet', 'issensitive(lookup({ a = sensitive("x") }, random_string.s.result, "d"))', false],
    [
      'issensitive of merge with an argument not known yet',
      `issensitive(merge({ a = sensitive("x") }, { for k in [random_string.s.result] : (length(k) == 4 ? "a" : "b") => "y" }))`,
      false,
    ],
    ['issensitive of an index not known yet', `issensitive(${AT})`, false, '[sensitive("a"), "b"]'],
    ['issensitive of a plain part an index not known yet reads', 'issensitive(local.l[length(random_string.s.result) - 4].b)', false, '[{ a = sensitive("x"), b = "y" }]'],
    [
      'issensitive of a part only one result of a condition marks',
      'issensitive(local.l.b)',
      false,
      'length(random_string.s.result) == 4 ? { a = sensitive("x"), b = "y" } : { a = "x", b = sensitive("y") }',
    ],
    ['issensitive of a for whose if is not known yet', `issensitive([for i in [0, 1] : (i == 0 ? sensitive("a") : "b") if i == 1 || ${LATER}])`, false],
    ['issensitive of a for whose if is not known yet, for a sensitive key', `issensitive({ for i in [0, 1] : (i == 0 ? sensitive("k") : "j") => i if i == 1 || ${LATER} })`, false],
    [
      'issensitive of a plain part of what a for whose if is not known yet gives',
      'issensitive(local.l[0].b)',
      false,
      `[for i in [0, 1] : { a = sensitive("x"), b = "y" } if i == 0 || ${LATER}]`,
    ],
    [
      'issensitive of a plain value of a for whose key is not known yet',
      'issensitive(local.l.b)',
      false,
      '{ for o in [{ k = "b", v = "y" }, { k = random_string.s.result, v = sensitive("x") }] : o.k => o.v }',
    ],
    [
      'issensitive of a plain part of what a for over a collection not known yet gives',
      'issensitive(local.l[0].b)',
      false,
      '[for x in tolist(toset([random_string.s.result])) : { a = sensitive(x), b = "y" }]',
    ],
    [
      'issensitive of how many values a for whose key is not known yet groups',
      'issensitive(length(local.l.b))',
      false,
      '{ for k in ["b", random_string.s.result] : k => sensitive(k)... }',
    ],
    [
      'issensitive of how many values a for over a collection not known yet groups',
      'issensitive(length(local.l.k))',
      false,
      '{ for x in tolist(toset([random_string.s.result])) : "k" => sensitive(x)... }',
    ],
    [
      'issensitive of a for whose if drops an item for certain, where only one it may drop is sensitive',
      'issensitive(local.l)',
      false,
      `[for x in ["z", "a", "b"] : (x == "b" ? sensitive(x) : x) if x != "z" && (x == "a" || ${LATER})]`,
    ],
    [
      'issensitive of a for over a for, where the key it reads is plain',
      'issensitive(local.m.b)',
      false,
      `{ for x in ["a", "b", "c"] : x => (x == "a" ? sensitive("s") : "p") if x != "c" || ${LATER} }`,
      '{ for k, v in local.l : k => v }',
    ],
    ['issensitive of a known value with a part a condition not known yet makes sensitive', `issensitive({ a = ${LATER} ? "y" : sensitive("x") })`, true],
    [
      'issensitive of a merge that gives a part a condition not known yet makes sensitive',
      'issensitive(merge(local.l, {}))',
      true,
      `${LATER} ? { a = "x" } : { a = sensitive("y") }`,
    ],
    ['issensitive of a for over a collection not known yet that comes out empty', `issensitive([for x in (${LATER} ? ["a"] : []) : sensitive(x)])`, false],
    [
      'issensitive of a condition whose other side is a for over a collection not known yet that comes out empty',
      `issensitive(${LATER} ? [sensitive("a")] : [for x in (${LATER} ? ["a"] : []) : sensitive(x)])`,
      false,
    ],
  ])('is sensitive only where the side the apply takes is, for %s', async (_, value, expected, list?: string, over?: string) => {
    await apply(output(value, list, over));

    expect(await outputs()).toEqual({ o: expected });
  });

  it.each([
    ['a condition', `${LATER} ? sensitive("a") : "b"`],
    ['a condition the other way', `!(${LATER}) ? sensitive("a") : "b"`],
    ['&&', `${LATER} && sensitive(true)`],
    ['||', `${LATER} || sensitive(false)`],
    ['a for over a collection not known yet that may come out empty, with every item sensitive', `[for x in (${LATER} ? ["a"] : []) : sensitive(x)]`],
    ['a value that holds such a for', `{ o = [for x in (${LATER} ? ["a"] : []) : sensitive(x)] }`],
  ])('refuses at plan an output that may hold a sensitive value by what the apply finds, for %s', async (_, value) => {
    await expect(newOrchestrator().plan(output(value))).rejects.toThrow(MAYBE_REFUSED);
  });

  it.each([
    ['a condition', 'local.l', `${LATER} ? { a = sensitive("x"), b = "y" } : { a = "x", b = sensitive("y") }`],
    ['an index not known yet', AT, '[{ a = sensitive("x"), b = "y" }, { a = "x", b = sensitive("y") }]'],
    ['a for over it that gives each item', '[for v in local.l : v]', `${LATER} ? [sensitive("a"), "b"] : ["c", sensitive("d")]`],
    ['a for over it that gives each value in key order', '[for k, v in local.l : v]', `${LATER} ? { a = sensitive("x"), b = "y" } : { a = "z", b = sensitive("w") }`],
    ['a for over it that makes an object', '{ for k, v in local.l : k => v }', `${LATER} ? { a = sensitive("x"), b = "y" } : { a = "z", b = sensitive("w") }`],
    ['a for over it that groups', '{ for v in local.l : "g" => v... }', `${LATER} ? [sensitive("a"), "b"] : ["c", sensitive("d")]`],
    ['a for over it whose body is sensitive where the item is', '[for v in local.l : upper(v)]', `${LATER} ? [sensitive("a"), "b"] : ["c", sensitive("d")]`],
    ['a merge of it with nothing after', 'merge(local.l, {})', `${LATER} ? { a = sensitive("x"), b = "y" } : { a = "z", b = sensitive("w") }`],
    ['a merge of it with a key after it does not hold', 'merge(local.l, { c = "1" })', `${LATER} ? { a = sensitive("x"), b = "y" } : { a = "z", b = sensitive("w") }`],
    ['a merge of it after a key', 'merge({ c = "1" }, local.l)', `${LATER} ? { a = sensitive("x"), b = "y" } : { a = "z", b = sensitive("w") }`],
    [
      'a for over it whose if reads the item, which makes how many it keeps sensitive',
      'length([for v in local.l : v if v != random_string.s.result])',
      `${LATER} ? [sensitive("a"), "b"] : ["c", sensitive("d")]`,
    ],
    ['a for over it whose key is the item, which makes its keys sensitive', '{ for v in local.l : v => 1 }', `${LATER} ? [sensitive("a"), "b"] : ["c", sensitive("d")]`],
  ])('knows at plan that what is sensitive somewhere in every outcome is sensitive, for %s', async (_, value, list) => {
    const plan = await newOrchestrator().plan(output(`issensitive(${value})`, list));

    expect(plan.outputs.o.new).toEqual({ value: true, type: types.bool });
  });

  it('goes over only the keys a value sensitive somewhere holds, for a for over it', async () => {
    const plan = await newOrchestrator().plan(
      output('{ for k, v in local.l : (k == "a" ? "x" : "y") => 1 }', `${LATER} ? { a = sensitive("x"), b = "y" } : { a = "x", b = sensitive("y") }`)
    );

    expect(plan.outputs.o.new?.value).toBe(UNKNOWN);
  });

  it('knows at plan what && gives where its right side decides and neither side is sensitive', async () => {
    const plan = await newOrchestrator().plan(output(`${LATER} && false`));

    expect(plan.outputs.o.new).toEqual({ value: false, type: types.bool });
  });

  it.each([
    ['both sides of a condition', `${LATER} ? sensitive("a") : sensitive("b")`],
    ['a sensitive condition', `sensitive(${LATER}) ? "a" : "b"`],
    ['a sensitive left side of &&', `sensitive(${LATER}) && true`],
    ['both sides of && where its right side decides', `sensitive(${LATER}) && sensitive(false)`],
    ['both sides of && not known', `sensitive(length(random_string.s.result) == 4) && sensitive(${LATER})`],
    ['lookup with a sensitive key not known yet', 'lookup({ a = "x" }, sensitive(random_string.s.result), "d")'],
    ['lookup in a sensitive map with a key not known yet', 'lookup(sensitive({ a = "x" }), random_string.s.result, "d")'],
    ['merge with a sensitive argument and one not known yet', 'merge(sensitive({ a = "x" }), { for k in [random_string.s.result] : k => "y" })'],
    ['a sensitive index not known yet', 'local.l[sensitive(length(random_string.s.result) - 3)]', '["a", "b"]'],
    ['an index not known yet into a sensitive list', AT, 'sensitive(["a", "b"])'],
    ['an index not known yet where every item is sensitive', AT, '[sensitive("a"), sensitive("b")]'],
    [
      'an index not known yet into a for not known yet where every item is sensitive',
      'local.l[length(random_string.s.result) - 4]',
      `[for x in ["a", "b"] : sensitive(x) if x == "a" || ${LATER}]`,
    ],
    ['a part both results of a condition mark', 'local.l.a', `${LATER} ? { a = sensitive("x"), b = "y" } : { a = sensitive("z"), b = "w" }`],
    ['an index not known yet where every item marks the part read', `${AT}.a`, '[{ a = sensitive("x") }, { a = sensitive("y") }]'],
    ['an index not known yet where every item has a sensitive part', AT, '[{ a = sensitive("x") }, { a = sensitive("y") }]'],
    ['an index past one not known yet where every item marks every item', `${AT}[0]`, '[[sensitive("x")], [sensitive("y")]]'],
    ['lookup with a key not known yet where every value and the default are sensitive', 'lookup({ a = sensitive("x") }, random_string.s.result, sensitive("d"))'],
    ['a known index past one not known yet', `${AT}[1 - 1]`, '[[sensitive("x")], [sensitive("y")]]'],
    ['a sensitive index past one not known yet', `${AT}[sensitive(1 - 1)]`, '[["a"], ["b"]]'],
    ['merge with an argument not known yet that marks a key it gives', `merge(${AT}, {})`, '[{ a = sensitive("x"), b = "1" }, { a = sensitive("y"), b = "2" }]'],
    ['lookup of a key a value not known yet marks', `lookup(${AT}, "a", "d")`, '[{ a = sensitive("x"), b = "1" }, { a = sensitive("y"), b = "2" }]'],
    ['merge where every value of every argument is sensitive', 'merge({ a = sensitive("x") }, { for k in tolist(toset([random_string.s.result])) : k => sensitive(k) })'],
    ['merge with a sensitive key after its last argument not known yet', 'merge({ for k in [random_string.s.result] : k => "y" }, { a = sensitive("x") })'],
    ['a for whose if is not known yet, where every item is sensitive', 'local.l[0]', `[for x in ["a", "b"] : sensitive(x) if x == "a" || ${LATER}]`],
    [
      'a for whose if is not known yet, with a sensitive key of an item it keeps',
      'length(local.l)',
      `{ for x in ["a", "b"] : (x == "a" ? sensitive(x) : x) => 1 if x == "a" || ${LATER} }`,
    ],
    ['a for whose if is not known yet, at the key of an item it keeps', 'local.l.a', `{ for x in ["a", "b"] : x => (x == "a" ? sensitive("s") : "p") if x == "a" || ${LATER} }`],
    [
      'a for whose if is not known yet, at the place of an item it keeps before any it may drop',
      'local.l[0]',
      `[for x in ["a", "b"] : (x == "a" ? sensitive(x) : x) if x == "a" || ${LATER}]`,
    ],
    [
      'a for whose if is not known yet, grouping at a key every value it may hold is sensitive',
      'local.l.k[0]',
      `{ for x in ["a", "b"] : "k" => sensitive(x)... if x == "a" || ${LATER} }`,
    ],
    ['a for whose key is not known yet, where every value is sensitive', 'local.l.b', '{ for k in ["b", random_string.s.result] : k => sensitive(k) }'],
    ['a for whose key is not known yet, with a sensitive key', 'length(local.l)', '{ for k in [random_string.s.result] : sensitive(k) => 1 }'],
    ['a for whose key is not known yet, at a key it knows', 'local.l.b', '{ for o in [{ k = "b", v = sensitive("y") }, { k = random_string.s.result, v = "x" }] : o.k => o.v }'],
    ['a for whose key is not known yet, where every value it groups is sensitive', 'local.l.b[0]', '{ for k in ["b", random_string.s.result] : k => sensitive(k)... }'],
    ['a for over a collection not known yet whose body is sensitive as a whole', 'local.l[0]', '[for x in tolist(toset([random_string.s.result])) : sensitive(x)]'],
    [
      'a for whose if is not known yet, grouping at a key only sensitive values may join',
      'local.l.k[0]',
      `{ for x in ["a", "b", "c"] : (x == "c" ? "z" : "k") => (x == "c" ? "p" : sensitive(x))... if x == "a" || ${LATER} }`,
    ],
    [
      'a for over the keys a for not known yet gives for certain',
      'local.m.a',
      `{ for x in ["a", "b"] : x => (x == "a" ? sensitive("s") : "p") if x == "a" || ${LATER} }`,
      '{ for k, v in local.l : k => v }',
    ],
    [
      'a for over the places a for not known yet gives for certain',
      'local.m[0]',
      `[for x in ["a", "b"] : (x == "a" ? sensitive(x) : x) if x == "a" || ${LATER}]`,
      '[for y in local.l : y]',
    ],
    [
      'a for whose if drops an item for certain, at the key of one it keeps',
      'local.l.a',
      `{ for x in ["z", "a", "b"] : x => (x == "a" ? sensitive(x) : x) if x != "z" && (x == "a" || ${LATER}) }`,
    ],
    [
      'a for over the keys a for not known yet gives for certain, with a sensitive if',
      'length(local.m)',
      `{ for x in ["a", "b"] : x => (x == "a" ? sensitive("s") : "p") if x == "a" || ${LATER} }`,
      '{ for k, v in local.l : k => 1 if v == "s" }',
    ],
    [
      'a for over the places a for not known yet gives for certain, with a sensitive if',
      'length(local.m)',
      `[for x in ["a", "b"] : (x == "a" ? sensitive(x) : x) if x == "a" || ${LATER}]`,
      '[for v in local.l : 1 if v == "a"]',
    ],
    [
      'a for over the keys a for not known yet gives for certain, with a sensitive key',
      'length(local.m)',
      `{ for x in ["a", "b"] : x => (x == "a" ? sensitive("s") : "p") if x == "a" || ${LATER} }`,
      '{ for k, v in local.l : v => 1 }',
    ],
    ['what each result of a condition marks at another part', 'local.l', `${LATER} ? { a = sensitive("x"), b = "y" } : { a = "x", b = sensitive("y") }`],
    [
      'the part each result of a condition marks somewhere else in',
      'local.l.o',
      `${LATER} ? { o = { a = sensitive("x"), b = "y" }, p = "z" } : { o = { a = "x", b = sensitive("y") }, p = "z" }`,
    ],
    ['what each item an index not known yet reads marks at another part', AT, '[{ a = sensitive("x"), b = "y" }, { a = "x", b = sensitive("y") }]'],
    [
      'a comparison with what each result of a condition marks at another part',
      'local.l == { a = "x", b = "y" }',
      `${LATER} ? { a = sensitive("x"), b = "y" } : { a = "x", b = sensitive("y") }`,
    ],
    [
      'the first place in a group a for over a tuple not known yet makes',
      'local.m.g[0]',
      `${LATER} ? [sensitive("a"), "b"] : [sensitive("c"), "d"]`,
      '{ for v in local.l : "g" => v... }',
    ],
    [
      'the first place in a group a for over an object not known yet makes',
      'local.m.g[0]',
      `${LATER} ? { a = sensitive("x"), b = "y" } : { a = sensitive("z"), b = "w" }`,
      '{ for k, v in local.l : "g" => v... }',
    ],
    [
      'the first place of a for over an object not known yet, in key order',
      'local.m[0]',
      `${LATER} ? { a = sensitive("x"), b = "y" } : { a = sensitive("z"), b = "w" }`,
      '[for k, v in local.l : v]',
    ],
    [
      'the first place of a for over a tuple not known yet, whose if keeps the first item for certain',
      'local.m[0]',
      `${LATER} ? [sensitive("a"), "b"] : [sensitive("c"), "d"]`,
      `[for i, v in local.l : v if i == 0 || ${LATER}]`,
    ],
    [
      'the first place in a group a for makes, whose if keeps the first item for certain',
      'local.m.g[0]',
      '[sensitive("a"), "b"]',
      `{ for i, v in local.l : "g" => v... if i == 0 || ${LATER} }`,
    ],
    [
      'the first place of a for over an object, whose if keeps the first key for certain',
      'local.m[0]',
      '{ a = sensitive("x"), b = "y" }',
      `[for k, v in local.l : v if k == "a" || ${LATER}]`,
    ],
    [
      'the first place of a for over an object not known yet written out of key order',
      'local.m[0]',
      `${LATER} ? { b = "y", a = sensitive("x") } : { b = "w", a = sensitive("z") }`,
      '[for k, v in local.l : v]',
    ],
    [
      'the first place of a for over a list not known yet that holds it for certain, whose if keeps it',
      'local.m[0]',
      `${LATER} ? tolist([sensitive("a"), "b"]) : tolist([sensitive("c")])`,
      `[for i, v in local.l : v if i == 0 || ${LATER}]`,
    ],
    [
      'the first place in a group after an item an if may keep under another key',
      'local.m.g[0]',
      '["x", sensitive("b"), "c"]',
      `{ for i, v in local.l : (i == 0 ? "h" : "g") => v... if i != 0 || ${LATER} }`,
    ],
    [
      'the third place in a group a for over a list not known yet makes, where marks name only the first and third',
      'local.m.g[2]',
      `${LATER} ? tolist([sensitive("a"), "b", sensitive("e")]) : tolist([sensitive("c"), "d", sensitive("f")])`,
      '{ for v in local.l : "g" => v... }',
    ],
    [
      'the third place of a for over a list not known yet whose if keeps it, where marks name only the first and third',
      'local.m[2]',
      `${LATER} ? tolist([sensitive("a"), "b", sensitive("e")]) : tolist([sensitive("c"), "d", sensitive("f")])`,
      `[for i, v in local.l : v if i < 5 || ${LATER}]`,
    ],
  ])('refuses at plan an output sensitive whichever side the apply takes, for %s', async (_, value, list?: string, over?: string) => {
    await expect(newOrchestrator().plan(output(value, list, over))).rejects.toThrow(REFUSED);
  });

  it.each([
    ['a part only one result of a condition marks', 'issensitive(local.l.b)', `${LATER} ? { a = sensitive("x"), b = "y" } : { a = sensitive("z"), b = "w" }`],
    ['an index not known yet into an empty list', AT, '[]'],
    [
      'lookup of a key a value not known yet does not mark, with a sensitive default',
      `issensitive(lookup(${AT}, "b", sensitive("d")))`,
      '[{ a = sensitive("x"), b = "1" }, { a = sensitive("y"), b = "2" }]',
    ],
    [
      'merge where a later argument gives the key one not known yet marks',
      `issensitive(merge(${AT}, { a = "z" }))`,
      '[{ a = sensitive("x"), b = "1" }, { a = sensitive("y"), b = "2" }]',
    ],
    [
      'an index not known yet past another, where the part it reads is marked in no item',
      `issensitive(${AT}[length(random_string.s.result) - 4])`,
      '[["a", sensitive("x")], ["b", sensitive("y")]]',
    ],
    ['issensitive of a for over a collection not known yet, where every item is sensitive', `issensitive([for x in (${LATER} ? ["a"] : []) : sensitive(x)])`, '[]'],
    [
      'a part of what each result of a condition marks somewhere, where one result leaves it plain',
      'issensitive(local.l.p)',
      `${LATER} ? { o = { a = sensitive("x") }, p = "z" } : { o = { a = "x" }, p = sensitive("z") }`,
    ],
    [
      'what each result of a condition marks at another part, where one mark is under every item of what may come out empty',
      'issensitive(local.l)',
      `${LATER} ? { a = [for x in (${LATER} ? ["a"] : []) : sensitive(x)], b = "y" } : { a = [], b = sensitive("y") }`,
    ],
    ['the place in a group after an item that may join it', 'issensitive(local.m.g[0])', '["a", sensitive("b")]', `{ for i, v in local.l : "g" => v... if i == 1 || ${LATER} }`],
    [
      'the place of an item after one an if may drop, over a tuple not known yet',
      'issensitive(local.m[0])',
      `${LATER} ? ["a", sensitive("b")] : ["c", sensitive("d")]`,
      `[for i, v in local.l : v if i == 1 || ${LATER}]`,
    ],
    [
      'the second place of a for over an object not known yet written out of key order',
      'issensitive(local.m[1])',
      `${LATER} ? { b = "y", a = sensitive("x") } : { b = "w", a = sensitive("z") }`,
      '[for k, v in local.l : v]',
    ],
    [
      'the place in a group after an item whose key is not known yet',
      'issensitive(local.m.g[0])',
      '["a", sensitive("b")]',
      '{ for i, v in local.l : (i == 0 ? random_string.s.result : "g") => v... }',
    ],
    [
      'the place after the last a mark names in a group over a list not known yet',
      'issensitive(local.m.g[3])',
      `${LATER} ? tolist([sensitive("a"), "b", sensitive("e")]) : tolist([sensitive("c"), "d", sensitive("f")])`,
      '{ for v in local.l : "g" => v... }',
    ],
    [
      'issensitive of a for over what is sensitive somewhere, whose body reads one part',
      'issensitive([for k, v in local.l : v.a])',
      `${LATER} ? { p = { a = sensitive("x"), b = "y" }, q = { a = "z", b = "w" } } : { p = { a = "x", b = "y" }, q = { a = "z", b = sensitive("w") } }`,
    ],
    [
      'issensitive of a for over what is sensitive somewhere, whose if is not known yet and does not read the item',
      `issensitive([for v in local.l : v if random_string.s.result == "q"])`,
      `${LATER} ? [sensitive("a"), "b"] : ["c", sensitive("d")]`,
    ],
    [
      'issensitive of a merge of what is sensitive somewhere, with a key after it holds',
      'issensitive(merge(local.l, { a = "q" }))',
      `${LATER} ? { a = sensitive("x"), b = "y" } : { a = "z", b = sensitive("w") }`,
    ],
    [
      'issensitive of a merge of what is sensitive somewhere, with a map not known yet after it',
      'issensitive(merge(local.l, { for k in [random_string.s.result] : k => "q" }))',
      `${LATER} ? { a = sensitive("x"), b = "y" } : { a = "z", b = sensitive("w") }`,
    ],
    [
      'issensitive of a for over what is sensitive somewhere, keyed by the item under an if not known yet',
      'issensitive({ for v in local.l : v => 1 if random_string.s.result == "q" })',
      `${LATER} ? [sensitive("a"), "b"] : ["c", sensitive("d")]`,
    ],
    [
      'issensitive of a for over a list not known yet whose every item is sensitive somewhere, which may come out empty',
      'issensitive([for v in local.m : v])',
      `[for x in (${LATER} ? ["a"] : []) : (x == "q" ? { a = sensitive("x"), b = "y" } : { a = "z", b = sensitive("w") })]`,
      '[for x in local.l : x]',
    ],
  ])('leaves to the apply whether what no outcome marks at plan is sensitive, for %s', async (_, value, list, over?: string) => {
    const plan = await newOrchestrator().plan(output(value, list, over));

    expect(plan.outputs.o.new?.value).toBe(UNKNOWN);
  });
});
