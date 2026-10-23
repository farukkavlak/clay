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

const output = (value: string, list = '[]') => `resource "random_string" "s" { length = 4 }\nlocals { l = ${list} }\noutput "o" {\n  value = ${value}\n}`;

// Read at the index the string's length gives once made: 1.
const AT = 'local.l[length(random_string.s.result) - 3]';

const REFUSED = 'output "o" holds a sensitive value; write sensitive = true to export it';

// A choice not known at plan gives a value not known either, so a mark on only one side waits for the apply.
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
    ['a condition', `${LATER} ? sensitive("a") : "b"`, 'b'],
    ['&&', `${LATER} && sensitive(true)`, false],
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
  ])('is sensitive only where the side the apply takes is, for %s', async (_, value, expected, list?: string) => {
    await apply(output(value, list));

    expect(await outputs()).toEqual({ o: expected });
  });

  it.each([
    ['a condition', `!(${LATER}) ? sensitive("a") : "b"`],
    ['||', `${LATER} || sensitive(false)`],
  ])('refuses at the apply an output the side it takes makes sensitive, for %s', async (_, value) => {
    await newOrchestrator().plan(output(value));

    await expect(apply(output(value))).rejects.toThrow(REFUSED);
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
  ])('refuses at plan an output sensitive whichever side the apply takes, for %s', async (_, value, list?: string) => {
    await expect(newOrchestrator().plan(output(value, list))).rejects.toThrow(REFUSED);
  });

  it.each([
    ['a part only one result of a condition marks', 'local.l.b', `${LATER} ? { a = sensitive("x"), b = "y" } : { a = sensitive("z"), b = "w" }`],
    ['an index not known yet into an empty list', AT, '[]'],
    [
      'lookup of a key a value not known yet does not mark, with a sensitive default',
      `lookup(${AT}, "b", sensitive("d"))`,
      '[{ a = sensitive("x"), b = "1" }, { a = sensitive("y"), b = "2" }]',
    ],
    ['merge where a later argument gives the key one not known yet marks', `merge(${AT}, { a = "z" })`, '[{ a = sensitive("x"), b = "1" }, { a = sensitive("y"), b = "2" }]'],
    [
      'an index not known yet past another, where the part it reads is marked in no item',
      `${AT}[length(random_string.s.result) - 4]`,
      '[["a", sensitive("x")], ["b", sensitive("y")]]',
    ],
  ])('leaves to the apply what no outcome marks at plan, for %s', async (_, value, list) => {
    const plan = await newOrchestrator().plan(output(value, list));

    expect(plan.outputs.o.new?.value).toBe(UNKNOWN);
  });
});
