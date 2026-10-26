import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from '../start';

// Not known at plan, and true once the string is made.
const NOW = 'length(random_string.s.result) == 4';
// A list of one item at apply, of no type at plan: a for over a collection not known yet.
const ONE = `[for x in (${NOW} ? [1] : [1, 2]) : { k = "s" }]`;
const TWO = '[{ k = "s" }, { k = "s" }]';
// The string "s" at apply, of no type at plan.
const TEXT = `[for x in (${NOW} ? [1] : [1, 2]) : "s"][0]`;
// A list of the string "s" at apply, of no type at plan: joined with [1], it makes it ["1"].
const TEXTS = `[for x in (${NOW} ? [1] : [1, 2]) : "s"]`;

const config = (local: string, extra = '') => `resource "random_string" "s" { length = 4 }
locals {
  l = ${local}
}
${extra}output "o" {
  value = { for v in local.l : "a" => v.k }
}
`;

const output = (value: string, extra = '') => `resource "random_string" "s" { length = 4 }
${extra}output "o" {
  value = ${value}
}
`;

describe('a value of no type yet joined with others', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (text: string) => {
    for await (const event of start(newOrchestrator(), text)) if (event.type === 'failed') throw event.error;
  };

  const module = async (name: string, text: string) => {
    await fs.mkdir(path.join(dir, name));
    await fs.writeFile(path.join(dir, name, 'main.clay'), text, 'utf8');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-shape-to-come-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Each holds one item at apply; reading its shape from the other would count two at plan, and refuse two items for the key "a".
  it.each([
    ['as one result of a condition not known yet', `${NOW} ? ${ONE} : ${TWO}`],
    ['as the result a known condition picks', `true ? ${ONE} : ${TWO}`],
    ['below a key, as one result of a condition not known yet', `(${NOW} ? { w = ${ONE} } : { w = ${TWO} }).w`],
    ['as the items of a list, one result of a condition not known yet', `(${NOW} ? tolist([${ONE}]) : tolist([${TWO}]))[0]`],
    ['as a later item of a list, one result of a condition not known yet', `(${NOW} ? tolist([[null], [${ONE}]]) : tolist([[${TWO}]]))[1][0]`],
  ])('takes no shape from the other, %s', async (_, local) => {
    await apply(config(local));

    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: { a: 's' } });
  });

  it('takes no shape from the other, as the result a known condition picks in a module instance', async () => {
    await module('m', 'variable "v" {}\noutput "o" { value = var.v }\n');
    const call = `module "m" {\n  count  = 2\n  source = "./m"\n  v      = count.index == 0 ? ${ONE} : ${TWO}\n}\n`;

    await apply(config('module.m[0].o', call));

    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: { a: 's' } });
  });

  it('refuses at plan results of a condition not known yet that could never join, though one has a part still to come', async () => {
    await expect(newOrchestrator().plan(config(`${NOW} ? local.a : local.b`, `locals {\n  a = tolist([${ONE}])\n  b = [["a"], [["a"]]]\n}\n`))).rejects.toThrow(
      'The two results of a conditional cannot join a string and a tuple'
    );
  });

  // The map is not known yet in one, the key in the other, so either may give the default.
  it.each([
    ['a map not known yet', `${NOW} ? { x = ${TWO} } : { x = ${TWO} }`, '"y"'],
    ['a key not known yet', `{ x = ${TWO} }`, 'random_string.s.result'],
  ])('takes no shape from the values of a map, as the default of a lookup in %s', async (_, map, key) => {
    await module('n', 'variable "m" {\n  type = map(any)\n}\nvariable "k" {}\nvariable "d" {}\noutput "o" { value = lookup(var.m, var.k, var.d) }\n');
    const call = `module "n" {\n  source = "./n"\n  m      = ${map}\n  k      = ${key}\n  d      = ${ONE}\n}\n`;

    await apply(config('module.n.o', call));

    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: { a: 's' } });
  });

  // A number at plan would be the string "s" at apply, which the plan did not show.
  it.each([
    ['as one result of a condition not known yet', `${NOW} ? ${TEXT} : 1`],
    ['as the result a known condition picks', `true ? ${TEXT} : 1`],
  ])('takes no type from a number beside it, %s', async (_, value) => {
    await apply(output(value));

    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: 's' });
  });

  it('takes no type from the numbers of a map, as the default of a lookup at a key not known yet', async () => {
    await module('n', 'variable "m" {\n  type = map(any)\n}\nvariable "k" {}\nvariable "d" {}\noutput "o" { value = lookup(var.m, var.k, var.d) }\n');
    const call = `module "n" {\n  source = "./n"\n  m      = { x = 1 }\n  k      = random_string.s.result\n  d      = ${TEXT}\n}\n`;

    await apply(output('module.n.o', call));

    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: 's' });
  });

  // The tuple [ONE, TWO] joins into a list only once ONE is known.
  it('takes no shape from the other items of a list', async () => {
    await apply(config(`tolist([${ONE}, ${TWO}])[0]`));

    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: { a: 's' } });
  });

  it.each([
    ['a list', `tolist([${TEXTS}, [1]])[1][0]`],
    ['a string, in a list', `tolist([${TEXT}, 1])[1]`],
  ])('converts a known value only at apply, beside %s of no type yet', async (_, value) => {
    const text = output(value);
    const plan = await newOrchestrator().plan(text);
    expect(plan.outputs.o.new).toEqual({ value: UNKNOWN, type: types.dynamic });

    await apply(text);
    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: '1' });
  });

  it('keeps sensitive a part not known until apply, beside a value of no type yet', async () => {
    await expect(newOrchestrator().plan(output(`tolist([${TEXTS}, [sensitive(1)]])[1][0]`))).rejects.toThrow('output "o" holds a sensitive value');
  });

  it('keeps sensitive as a whole a list of a value of no type yet and a known one', async () => {
    await expect(newOrchestrator().plan(output(`length(tolist(sensitive([${TEXTS}, [1]])))`))).rejects.toThrow('output "o" holds a sensitive value');
  });

  it('keeps sensitive as a whole a map of a value of no type yet and a known one', async () => {
    await module('n', 'variable "v" {\n  type = map(any)\n}\noutput "o" { value = length(var.v) }\n');
    const text = output('module.n.o', `module "n" {\n  source = "./n"\n  v      = sensitive({ x = ${TEXTS}, y = [1] })\n}\n`);

    await expect(newOrchestrator().plan(text)).rejects.toThrow('holds a sensitive value');
  });

  it('keeps a null known at plan, beside a value of no type yet', async () => {
    const text = output(`tolist([null, ${TEXTS}])[0]`);
    const plan = await newOrchestrator().plan(text);
    expect(plan.outputs.o.new?.value).toBeNull();

    await apply(text);
    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: null });
  });

  // A string holds any primitive as text, so the join is a string whatever the other comes to.
  it('keeps known at plan a string beside a value of no type yet', async () => {
    const text = output(`tolist([${TEXT}, "x"])[1]`);
    const plan = await newOrchestrator().plan(text);
    expect(plan.outputs.o.new).toEqual({ value: 'x', type: types.string });

    await apply(text);
    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: 'x' });
  });

  it('keeps every mark of a list a value of no type yet joins, though a part is not known until apply', async () => {
    const merged = `merge(${NOW} ? { a = sensitive(1), b = 2 } : { a = 1, b = sensitive(2) }, { c = 3 })`;
    const plan = await newOrchestrator().plan(output(`issensitive(tolist([{ a = ${TEXT}, b = 1, c = 1 }, ${merged}])[1])`));
    expect(plan.outputs.o.new?.value).toBe(true);
  });

  it('gives a string at plan for a condition not known yet between a value of no type yet and a string', async () => {
    const plan = await newOrchestrator().plan(output(`${NOW} ? ${TEXT} : "x"`));
    expect(plan.outputs.o.new).toEqual({ value: UNKNOWN, type: types.string });
  });

  it('keeps known at plan the length of a list an item of no type yet joins', async () => {
    const text = output(`length(tolist([${TEXTS}, [1]]))`);
    const plan = await newOrchestrator().plan(text);
    expect(plan.outputs.o.new).toEqual({ value: ExactNumber.parse('2'), type: types.number });
  });

  it('keeps known at plan a part a value of no type yet does not reach', async () => {
    const text = output(`tolist([{ a = ${TEXT}, b = 1 }, { a = 1, b = "x" }])[0].b`);
    const plan = await newOrchestrator().plan(text);
    expect(plan.outputs.o.new).toEqual({ value: '1', type: types.string });

    await apply(text);
    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: '1' });
  });

  it.each([
    ['a list of any type', 'list(any)', `[${TEXTS}, [1]]`, 'var.v[1][0]'],
    ['a map of any type', 'map(any)', `{ x = ${TEXTS}, y = [1] }`, 'var.v.y[0]'],
    ['a list of any type in an object', 'object({ a = list(any) })', `{ a = [${TEXTS}, [1]] }`, 'var.v.a[1][0]'],
    ['a list of lists of any type', 'list(list(any))', `[[${TEXT}], [1]]`, 'var.v[1][0]'],
    ['a map of lists of any type', 'map(list(any))', `{ x = [${TEXT}], y = [1] }`, 'var.v.y[0]'],
  ])('converts a known value only at apply, in a variable of %s', async (_, type, given, read) => {
    await module('n', `variable "v" {\n  type = ${type}\n}\noutput "o" { value = ${read} }\n`);
    const text = output('module.n.o', `module "n" {\n  source = "./n"\n  v      = ${given}\n}\n`);

    await apply(text);
    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: '1' });
  });

  it('converts a known value only at apply, in a lookup with a default of no type yet', async () => {
    await module('n', 'variable "m" {\n  type = map(any)\n}\nvariable "d" {}\noutput "o" { value = lookup(var.m, "x", var.d)[0] }\n');
    const text = output('module.n.o', `module "n" {\n  source = "./n"\n  m      = { x = [1] }\n  d      = ${TEXTS}\n}\n`);

    await apply(text);
    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: '1' });
  });

  it('converts a known value only at apply, in the instances of a module read together', async () => {
    await module('m', 'variable "v" {}\noutput "o" { value = var.v }\n');
    const call = `module "m" {\n  count  = 2\n  source = "./m"\n  v      = count.index == 0 ? ${TEXTS} : [1]\n}\n`;

    await apply(output('[for m in module.m : m.o][1][0]', call));
    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: '1' });
  });

  // Once known, the value may be a string, which holds a number and a bool as text.
  it.each([
    ['in a list', `tolist([${TEXT}, 1, true])`, ['s', '1', 'true']],
    ['below the items of a list', `tolist([[${TEXT}], [1], [true]])`, [['s'], ['1'], ['true']]],
  ])('joins a number and a bool beside a value of no type yet, %s', async (_, value, joined) => {
    await apply(output(value));

    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: joined });
  });

  it('joins objects with other names beside a value of no type yet that comes to a map', async () => {
    await module('n', 'variable "m" {\n  type = map(string)\n}\nvariable "c" {}\noutput "o" { value = [for x in (var.c ? [1] : [1, 2]) : var.m][0] }\n');
    const call = `module "n" {\n  source = "./n"\n  m      = { a = "s" }\n  c      = ${NOW}\n}\n`;

    await apply(output('tolist([module.n.o, { b = "1" }, { c = "2" }])', call));

    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: [{ a: 's' }, { b: '1' }, { c: '2' }] });
  });

  it('joins objects with the same names beside a value of no type yet that comes to such an object', async () => {
    const item = `[for x in (${NOW} ? [1] : [1, 2]) : { name = "z", tags = ["c"] }][0]`;

    await apply(output(`tolist([${item}, { name = "x", tags = ["a"] }])`));

    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({
      value: [
        { name: 'z', tags: ['c'] },
        { name: 'x', tags: ['a'] },
      ],
    });
  });

  it('refuses at plan a number and a bool beside a value of no type yet that does not reach them', async () => {
    await expect(newOrchestrator().plan(output(`tolist([{ a = ${TEXT}, b = 1 }, { a = "x", b = true }])`))).rejects.toThrow('tolist cannot join a number and a boolean');
  });

  it('refuses at plan items that could never join below a value of no type yet', async () => {
    await expect(newOrchestrator().plan(output(`tolist([[[1]], [{ a = 1 }], [${TEXT}]])`))).rejects.toThrow('tolist cannot join a tuple and an object');
  });
});
