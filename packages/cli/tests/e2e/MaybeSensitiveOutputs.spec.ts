import { UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

// Not known at plan, and false once the string is made; NOW is true then.
const LATER = 'length(random_string.s.result) == 5';
const NOW = 'length(random_string.s.result) == 4';

const ONE_SIDE = `${LATER} ? "a" : sensitive("b")`;
const EITHER_PART = `${LATER} ? { a = sensitive("x"), b = "y", c = "0" } : { a = "z", b = sensitive("w"), c = "0" }`;
const BOTH_KEY = `${LATER} ? { a = sensitive("x"), c = "0" } : { a = sensitive("y"), c = "0" }`;
const ONE_PLACE = `${LATER} ? [sensitive("x"), "0"] : ["y", "0"]`;
const ONE_KEY = `${LATER} ? { a = sensitive("x"), c = "0" } : { a = "y", c = "0" }`;
const KEYED = `{ for k, v in (${ONE_KEY}) : k => v }`;
const PLACED = `[for v in (${ONE_PLACE}) : v]`;
const MERGED = 'merge({ for k in [random_string.s.result] : k => sensitive("q") }, { c = "0" })';
const PICKED = `[for i, v in ["0", sensitive("x")] : v if i == 0 || ${LATER}]`;
// Sensitive at `k` for certain, and exact at `c`.
const KEYED_EXACT = 'merge({ k = sensitive("s") }, { for k in [random_string.s.result] : k => sensitive("q") }, { c = "0" })';
const MAY_DROP = (keys: string) => `{ for k, v in { ${keys} } : k => v if ${LATER} }`;
const BEFORE = 'merge({ c = "0" }, { for k in [random_string.s.result] : k => sensitive("q") })';
const SOME = `(${LATER} ? [1] : [1, 2])`;

const MAYBE_REFUSED = 'output "o" may hold a sensitive value, by what the apply finds; write sensitive = true to export it';

const config = (local: string, block: string) => `resource "random_string" "s" { length = 4 }\nlocals {\n  l = ${local}\n}\n${block}\n`;

const output = (value: string, flag = '') => `output "o" {\n  value = ${value}${flag}\n}`;

// Each is sensitive once the apply takes the side it takes, so a plan that let it through would fail the apply after it made the resources.
const MAYBE: [string, string, string][] = [
  ['a condition with one sensitive side', ONE_SIDE, 'local.l'],
  ['&& whose right side may decide', `${NOW} && sensitive(true)`, 'local.l'],
  ['|| whose right side may decide', `${LATER} || sensitive(true)`, 'local.l'],
  ['lookup with a key not known yet', 'lookup({ abcd = "p", q = sensitive("s") }, random_string.s.result, sensitive("d"))', 'local.l'],
  ['an index not known yet', '["a", sensitive("b")]', 'local.l[length(random_string.s.result) - 3]'],
  ['merge with a map not known yet', 'merge({ a = sensitive("x") }, { for k in [random_string.s.result] : k => "y" })', 'local.l'],
  ['a for whose if is not known yet', `[for x in ["a"] : sensitive(x) if ${NOW}]`, 'local.l'],
  ['a for over a collection not known yet', `[for x in (${NOW} ? ["a"] : []) : sensitive(x)]`, 'local.l'],
  ['a for over a list tolist makes of a set with a member not known yet', '[for v in tolist(toset([random_string.s.result])) : sensitive(v)]', 'local.l'],
  ['an object made of parts each outcome marks apart', EITHER_PART, '{ p = local.l.a, q = local.l.b }'],
  ['merge over a plain key of such a value', EITHER_PART, 'merge(local.l, { c = "1" })'],
  ['a key merge keeps beside a map not known yet, which one outcome marks', ONE_KEY, 'merge(local.l, { for k in [random_string.s.result] : k => "q" }).a'],
  ['a key a for keeps, which one outcome marks', `{ for k, v in (${ONE_KEY}) : k => v }`, 'local.l.a'],
  ['a key a for may keep, which one outcome marks', `{ for k, v in (${ONE_KEY}) : k => v if ${NOW} }`, 'local.l.a'],
  ['a group a for keeps, which one outcome marks', `{ for k, v in (${ONE_KEY}) : k => v... }`, 'local.l.a[0]'],
  ['a group a for may keep, which one outcome marks', `{ for k, v in (${ONE_KEY}) : k => v... if ${NOW} }`, 'local.l.a[0]'],
  ['a key a for over what a for gives keeps, which one outcome marks', `{ for k, v in ${KEYED} : k => v }`, 'local.l.a'],
  ['a key merge keeps of what a for gives, which one outcome marks', KEYED, 'merge(local.l, {}).a'],
  ['a place a for over what a for gives keeps, which one outcome marks', `[for v in ${PLACED} : v]`, 'local.l[0]'],
  ['a place a for keeps, which one outcome marks', `[for v in (${LATER} ? [sensitive("x"), "0"] : ["y", "0"]) : v]`, 'local.l[0]'],
  [
    'a for reading one part, which one item or another marks',
    `${LATER} ? [{ a = sensitive("x") }, { a = "y" }] : [{ a = "y" }, { a = sensitive("x") }]`,
    '[for v in local.l : v.a]',
  ],
  ['upper of a condition with one sensitive side', ONE_SIDE, 'upper(local.l)'],
  ['== with a condition with one sensitive side', ONE_SIDE, 'local.l == "q"'],
  ['a template with a condition with one sensitive side', ONE_SIDE, '"x-${local.l}"'],
  ['length of a condition with one sensitive side', ONE_SIDE, 'length(local.l)'],
  ['what a module gives back of such a condition', ONE_SIDE, 'module.m.o'],
  ['what a resource holds of such a condition', ONE_SIDE, 'null_resource.n.triggers.t'],
  ['arithmetic on a condition with one sensitive side', `${LATER} ? 1 : sensitive(1)`, 'local.l + 1'],
  ['an ordering of a condition with one sensitive side', `${LATER} ? 1 : sensitive(1)`, 'local.l > 0'],
  ['whether a value that may be sensitive as a whole is null', `${LATER} ? {} : sensitive({})`, 'local.l == null'],
  ['lookup with a key that may be sensitive', ONE_SIDE, 'lookup({ a = "x", b = "y" }, local.l, "d")'],
  ['an index that may be sensitive', `${LATER} ? 0 : sensitive(1)`, 'tolist(["p", "q"])[local.l]'],
  ['merge of an empty object that may be sensitive as a whole', `${LATER} ? {} : sensitive({})`, 'merge(local.l, {})'],
  ['a for whose key may be sensitive', ONE_SIDE, '{ for x in [local.l] : x => 1 }'],
  ['a for whose key may be sensitive, under an if not known yet', ONE_SIDE, `{ for x in ["a"] : local.l => x if ${NOW} }`],
  ['a for whose if may be sensitive', `${NOW} ? sensitive(true) : true`, '[for x in ["a"] : x if local.l]'],
  ['a for over a collection that may be sensitive as a whole', `${LATER} ? ["a"] : sensitive(["b"])`, '[for x in local.l : "c"]'],
  ['a condition that may be sensitive, not known yet', `${NOW} ? sensitive(true) : false`, 'local.l ? "a" : "b"'],
  ['a for over a collection not known yet, whose key may be sensitive', `[for x in (${NOW} ? ["a"] : []) : x]`, `{ for x in local.l : (${NOW} ? sensitive(x) : x) => 1 }`],
  ['a for over a collection not known yet, whose if may be sensitive', `[for x in (${NOW} ? ["a"] : []) : x]`, `[for x in local.l : x if (${NOW} ? sensitive(true) : true)]`],
  ['a value given to a typed variable that may be sensitive as a whole', `${LATER} ? {} : sensitive({})`, 'module.t.o'],
  ['a condition on what either side of || may decide', `${LATER} || sensitive(true)`, 'local.l ? "a" : "b"'],
  ['a for over a list read with an index that may be sensitive', `${LATER} || sensitive(true)`, '[for x in tolist([["a"], ["b"]])[local.l ? 0 : 1] : "c"]'],
  [
    'a key merge gives from a value that may be sensitive, beside one sensitive somewhere',
    EITHER_PART,
    `merge(local.l, { c = length(merge(${LATER} ? {} : sensitive({}), {})) }).c`,
  ],
];

// Not known at plan, since either side may decide, and sensitive once the apply finds the left side false.
const EITHER = `(${LATER} || sensitive(true))`;

const exported = (value: string) => output(value, '\n  sensitive = true');

// Each error would show something of a value the apply may find sensitive.
const HIDDEN: [string, string, string, string | RegExp][] = [
  ['an index past the items', `${EITHER} ? ["secret"] : ["b"]`, exported('local.l[5]'), /local\.l has no item \[5\]$/],
  ['two results of other types', `${EITHER} ? ["secret"] : ["b"]`, exported('random_string.s.result == "q" ? local.l : { a = 1 }'), 'a part of it is sensitive, so no more'],
  ['a comparison of items of other types', `${EITHER} ? ["secret"] : ["b"]`, exported('local.l == [1]'), 'one is sensitive, so no more is shown'],
  [
    'a typed variable given other types',
    `${EITHER} ? ["secret", { a = 1 }] : ["b", { a = 2 }]`,
    'module "list" {\n  source = "./list"\n  v = local.l\n}',
    'it is sensitive, so its parts are not shown',
  ],
  ['tolist of items of other types', `${EITHER} ? ["secret", { a = 1 }] : ["b", { a = 2 }]`, exported('tolist(local.l)'), 'a part of it is sensitive, so no more is shown'],
  [
    'a list(any) variable given items of other types',
    `${EITHER} ? ["secret", { a = 1 }] : ["b", { a = 2 }]`,
    'module "any" {\n  source = "./any"\n  v = local.l\n}',
    'variable "v" cannot join what it holds into one type; a part of it is sensitive',
  ],
  [
    'a lookup default of another type',
    `${EITHER} ? { x = "secret" } : { x = "b" }`,
    'module "lookup" {\n  source = "./lookup"\n  m = { a = "p" }\n  d = local.l\n}',
    'lookup cannot join what it holds into one type; a part of it is sensitive',
  ],
  [
    'the instances of a module whose outputs take no one type',
    `${EITHER} ? ["secret"] : ["b"]`,
    'module "each" {\n  source   = "./m"\n  for_each = { a = "x", b = "y" }\n  v        = lookup({ a = local.l, b = { a = 1 } }, each.key, null)\n}\n' + exported('module.each'),
    'module.each cannot join what it holds into one type; a part of it is sensitive',
  ],
  [
    'two results of a known condition, one read by type that may be sensitive',
    `${EITHER} ? [{ secret = 1 }] : [{ secret = 2 }]`,
    exported('true ? local.l : [{ secret = "x", other = [1] }]'),
    'a part of it is sensitive, so no more is shown',
  ],
  [
    'two results of a known condition, one a module gives back that may be sensitive',
    `${EITHER} ? [{ secret = true }] : [{ secret = false }]`,
    'module "m" {\n  source = "./m"\n  v = local.l\n}\n' + exported('true ? module.m.o : [{ secret = 1 }]'),
    'a part of it is sensitive, so no more is shown',
  ],
];

// Each takes `v`, and `lookup` an `m` and a default `d` too.
const MODULES = {
  m: 'variable "v" {}\noutput "o" { value = var.v }\n',
  kz: 'variable "v" {\n  type = object({ k = string, z = string })\n}\noutput "o" { value = var.v }\n',
  t: 'variable "v" {\n  type = any\n}\noutput "o" { value = var.v }\n',
  list: 'variable "v" {\n  type = list(string)\n}\n',
  any: 'variable "v" {\n  type = list(any)\n}\n',
  objects: 'variable "v" {\n  type = map(object({ b = string, c = string }))\n}\noutput "o" { value = var.v }\n',
  strings: 'variable "v" {\n  type = list(string)\n}\noutput "o" { value = var.v }\n',
  merge: 'variable "x" {\n  type = object({ a = string, b = string })\n}\noutput "c" { value = merge(var.x, { c = 2 }).c }\n',
  map: 'variable "v" {\n  type = map(string)\n}\noutput "o" { value = var.v }\n',
  lookup: 'variable "m" {\n  type = map(string)\n}\nvariable "d" {}\noutput "o" { value = lookup(var.m, "a", var.d) }\n',
};

// Each outcome is a map or a list a module gives, and only one of them holds the sensitive part a mark names.
const either = (source: string, empty: string, full: string) =>
  `module "empty" {\n  source = "./${source}"\n  v = ${empty}\n}\nmodule "full" {\n  source = "./${source}"\n  v = ${full}\n}\n`;

// What a resource holds may be sensitive by the string's length: a merge of what may be an empty sensitive object.
const merged = (length: number) =>
  `resource "random_string" "s" { length = ${length} }\nresource "null_resource" "n" {\n  triggers = { t = "\${length(merge(${LATER} ? {} : sensitive({}), { c = "1" }))}" }\n}\n`;

describe('a root output that may hold a sensitive value', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (text: string) => {
    for await (const event of start(newOrchestrator(), text)) if (event.type === 'failed') throw event.error;
  };

  const around =
    'module "m" {\n  source = "./m"\n  v = local.l\n}\nmodule "t" {\n  source = "./t"\n  v = local.l\n}\nresource "null_resource" "n" {\n  triggers = { t = local.l }\n}\n';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-maybe-sensitive-'));
    for (const [name, text] of Object.entries(MODULES)) {
      await fs.mkdir(path.join(dir, name));
      await fs.writeFile(path.join(dir, name, 'main.clay'), text, 'utf8');
    }
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each(MAYBE)('is refused at plan, before the apply makes any resource, for %s', async (_, local, value) => {
    await expect(newOrchestrator().plan(config(local, around + output(value)))).rejects.toThrow(MAYBE_REFUSED);
  });

  it.each(MAYBE)('is exported where it says it is sensitive, for %s', async (_, local, value) => {
    await apply(config(local, around + output(value, '\n  sensitive = true')));

    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o.sensitive).toBe(true);
  });

  it.each([
    ['a plain part of a known value with a sensitive one', '{ a = "x", b = sensitive("y") }', 'local.l.a', 'x'],
    ['a known merge whose later argument gives the sensitive key plain', 'merge({ a = sensitive("x") }, { a = "y" })', 'local.l', { a: 'y' }],
    ['a value not known yet that no outcome marks', `${LATER} ? "a" : "b"`, 'local.l', 'b'],
    ['a known for over plain items', '[for x in ["a", "b"] : upper(x)]', 'local.l', ['A', 'B']],
    ['a part plain in each outcome of a value sensitive somewhere', EITHER_PART, 'local.l.c', '0'],
    ['lookup of such a part', EITHER_PART, 'lookup(local.l, "c", "d")', '0'],
    ['such a part, where that value is one side of another condition', `${NOW} ? (${EITHER_PART}) : { a = "1", b = "2", c = "3" }`, 'local.l.c', '0'],
    ['a known key merge keeps beside a map not known yet', ONE_KEY, 'merge(local.l, { for k in [random_string.s.result] : k => "q" }).c', '0'],
    ['a known key a for over such a value keeps', `{ for k, v in (${ONE_KEY}) : k => v }`, 'local.l.c', '0'],
    ['a known key a for over such a value may keep', `{ for k, v in (${ONE_KEY}) : k => v if ${NOW} }`, 'local.l.c', '0'],
    ['a known group a for over such a value keeps', `{ for k, v in (${ONE_KEY}) : k => v... }`, 'local.l.c[0]', '0'],
    ['a known group a for over such a value may keep', `{ for k, v in (${ONE_KEY}) : k => v... if ${NOW} }`, 'local.l.c[0]', '0'],
    ['a known key a for over what a for gives keeps', `{ for k, v in ${KEYED} : k => v }`, 'local.l.c', '0'],
    ['a known key merge keeps of what a for gives', KEYED, 'merge(local.l, {}).c', '0'],
    ['a known place a for over what a for gives keeps', `[for v in ${PLACED} : v]`, 'local.l[1]', '0'],
    ['a known place a for over such a tuple keeps', `[for v in (${LATER} ? [sensitive("x"), "0"] : ["y", "0"]) : v]`, 'local.l[1]', '0'],
    ['a key merge gives last, after a map not known yet', MERGED, 'local.l.c', '0'],
    ['a known key a for gives beside a key not known yet', '{ for k, v in { a = sensitive("x"), c = "0" } : (k == "a" ? random_string.s.result : k) => v }', 'local.l.c', '0'],
    ['a place a for keeps for certain before one it may drop', PICKED, 'local.l[0]', '0'],
    ['lookup of such a key merge gives, with a sensitive default', MERGED, 'lookup(local.l, "c", sensitive("d"))', '0'],
    ['such a key, merged again', MERGED, 'merge(local.l, {}).c', '0'],
    ['such a key, on each side of a condition', `${LATER} ? ${MERGED} : ${MERGED}`, 'local.l.c', '0'],
    ['such a key, through a for', `{ for k, v in (${MERGED}) : k => v }`, 'local.l.c', '0'],
    ['such a place, through a for', `[for v in (${PICKED}) : v]`, 'local.l[0]', '0'],
    [
      'a key for items a for may drop, on each side of a condition',
      `${LATER} ? ${MAY_DROP(`a = ${KEYED_EXACT}, e = ${KEYED_EXACT}`)} : ${MAY_DROP(`a = ${KEYED_EXACT}, e = ${KEYED_EXACT}`)}`,
      '{ for v in local.l : "a" => v.c }',
      {},
    ],
    [
      'a key for places a for may drop, on each side of a condition',
      `{ for v in (${LATER} ? [for v in [${KEYED_EXACT}, ${KEYED_EXACT}] : v if ${LATER}] : [for v in [${KEYED_EXACT}, ${KEYED_EXACT}] : v if ${LATER}]) : "a" => v.c }`,
      'local.l',
      {},
    ],
    ['such a key in every item of a for over a tuple not known yet', `[for x in ${SOME} : ${MERGED}]`, 'local.l[0].c', '0'],
    ['such a key in every item, through a for again', `[for v in [for x in ${SOME} : ${MERGED}] : v]`, 'local.l[0].c', '0'],
    ['such a key in every item of a group', `{ for x in ${SOME} : "g" => ${MERGED}... }`, 'local.l.g[0].c', '0'],
    ['such a key in every item at a key not known yet', `{ for x in (${LATER} ? ["a"] : ["a", "b"]) : x => ${MERGED} }`, 'local.l.a.c', '0'],
    ['such a key below another, on each side of a condition', `${LATER} ? { w = ${MERGED} } : { w = ${MERGED} }`, 'local.l.w.c', '0'],
    ['such a key in a place, on each side of a condition', `${LATER} ? [${MERGED}] : [${MERGED}]`, 'local.l[0].c', '0'],
    ['such a key in a list made of a condition', `tolist(${LATER} ? [${MERGED}] : [${MERGED}])`, 'local.l[0].c', '0'],
    ['such a key below an index not known yet', `[{ w = ${MERGED} }]`, 'local.l[length(random_string.s.result) - 4].w.c', '0'],
    ['lookup of such a key at a key a for may drop', `{ for k, v in { a = ${MERGED} } : k => v if ${LATER} }`, 'lookup(local.l, "a", { c = "1" }).c', '1'],
    ['such a key at a place a for may drop', `[for i, v in ["x", ${MERGED}] : v if i == 0 || ${NOW}]`, 'local.l[1].c', '0'],
    ['such a key at a place only items that hold it may take', `[for i, v in ["x", ${BEFORE}, ${MERGED}] : v if i == 0 || ${NOW}]`, 'local.l[2].c', '0'],
    ['lookup of such a key at a key merge may give', `merge({ for k, v in { a = ${MERGED} } : k => v if ${LATER} }, {})`, 'lookup(local.l, "a", { c = "1" }).c', '1'],
  ])('is not refused where no outcome is sensitive, for %s', async (_, local, value, expected) => {
    await apply(config(local, output(value)));

    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: expected });
  });

  // The apply finds each plain, but only by the key the string comes to, which the plan cannot know.
  it.each([
    ['a key merge gives before a map not known yet', '{ c = "0" }', `merge(local.l, { for k in [random_string.s.result] : k => sensitive("q") }).c`],
    [
      'a known key whose item a for may drop',
      `{ for k, v in { a = sensitive("x"), c = "0" } : (k == "a" ? random_string.s.result : k) => v if k == "a" || ${LATER} }`,
      'lookup(local.l, "c", "d")',
    ],
    [
      'a known group an item with a key not known yet may join',
      '{ for k, v in { a = sensitive("x"), c = "0" } : (k == "a" ? random_string.s.result : k) => v... }',
      'local.l.c[0]',
    ],
    ['a place after one a for may drop', `[for i, v in ["0", sensitive("x"), "1"] : v if i != 1 || ${LATER}]`, 'local.l[1]'],
    ['such a key below another, on one side of a condition only', `${LATER} ? { w = ${MERGED} } : { w = ${BEFORE} }`, 'local.l.w.c'],
    ['such a key at a place an item that does not hold it may take', `[for i, v in ["x", ${BEFORE}, ${MERGED}] : v if i == 0 || ${NOW}]`, 'local.l[1].c'],
    ['such a key in one item of a for over a tuple not known yet only', `[for x in ${SOME} : (x == 1 ? ${MERGED} : ${BEFORE})]`, 'local.l[0].c'],
    [
      'lookup of such a key in one value a for may keep only',
      `{ for k, v in { a = ${MERGED}, b = ${BEFORE} } : (k == "a" ? "k" : random_string.s.result) => v if ${LATER} }`,
      'lookup(local.l, "k", { c = "1" }).c',
    ],
  ])('is still refused at plan where an item the plan cannot name may land, for %s', async (_, local, value) => {
    await expect(newOrchestrator().plan(config(local, output(value)))).rejects.toThrow(MAYBE_REFUSED);
  });

  // The key may be missing, and then the apply finds the sensitive value the other argument holds there.
  it.each([
    ['a merge over a key a for may drop', `{ for k, v in { a = ${MERGED} } : k => v if ${LATER} }`, 'merge({ a = { c = sensitive("1") } }, local.l).a.c'],
    ['lookup of a key a for may drop', `{ for k, v in { a = ${MERGED} } : k => v if ${LATER} }`, 'lookup(local.l, "a", { c = sensitive("1") }).c'],
    ['a merge over a group a for may drop', `{ for k, v in { a = ${MERGED} } : "g" => v... if ${LATER} }`, 'merge({ g = [{ c = sensitive("1") }] }, local.l).g[0].c'],
    ['a merge over a key merge may give', `merge({ for k, v in { a = ${MERGED} } : k => v if ${LATER} }, {})`, 'merge({ a = { c = sensitive("1") } }, local.l).a.c'],
    [
      'a merge over a key a for may drop, on each side of a condition',
      `${LATER} ? ${MAY_DROP(`a = ${KEYED_EXACT}`)} : ${MAY_DROP(`a = ${KEYED_EXACT}`)}`,
      'merge({ a = { c = sensitive("1") } }, local.l).a.c',
    ],
    ['a for over a key a for may drop', `{ for k, v in { a = ${MERGED} } : k => v if ${LATER} }`, 'merge({ x = { c = sensitive("1") } }, { for k, v in local.l : "x" => v }).x.c'],
  ])('is refused at plan where a key that may be missing holds another exactly, for %s', async (_, local, value) => {
    await expect(newOrchestrator().plan(config(local, output(value)))).rejects.toThrow(MAYBE_REFUSED);
  });

  it('is refused at plan for a key one side of a condition holds exactly, where the other marks every item', async () => {
    const every = 'module "kz" {\n  source = "./kz"\n  v = { for k in [random_string.s.result, "x"] : (k == "x" ? "z" : "k") => sensitive(k) }\n}\n';
    const local = `${NOW} ? module.kz.o : merge({ for k in [random_string.s.result] : k => (${LATER} ? sensitive("q") : "q") }, { k = "a", z = sensitive("s") })`;

    await expect(newOrchestrator().plan(config(local, every + output('local.l.k')))).rejects.toThrow(MAYBE_REFUSED);
  });

  it('leaves issensitive not known at plan for the default of a lookup at a group a for may not make', async () => {
    const local = `{ for k, v in { a = sensitive("x"), c = "0" } : (k == "a" ? random_string.s.result : k) => v... if k == "a" || ${LATER} }`;
    const text = config(local, output('issensitive(lookup(local.l, "c", [sensitive("d")]))'));
    const plan = await newOrchestrator().plan(text);
    expect(plan.outputs.o.new?.value).toBe(UNKNOWN);

    await apply(text);
    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: true });
  });

  it.each([
    ['a set made of a value that may be sensitive', `toset([${NOW} ? "a" : sensitive("b")])`],
    ['an attribute a provider makes from one that may be sensitive', 'local_file.f.id'],
  ])('leaves issensitive not known at plan, for %s', async (_, value) => {
    const file = `resource "local_file" "f" {\n  path    = ${LATER} ? "${path.join(dir, 'a.txt')}" : sensitive("${path.join(dir, 'b.txt')}")\n  content = "x"\n}\n`;
    const plan = await newOrchestrator().plan(config('1', file + output(`issensitive(${value})`)));

    expect(plan.outputs.o.new?.value).toBe(UNKNOWN);
  });

  it.each([
    ['a key a for may keep', `{ for k, v in (${BOTH_KEY}) : k => v if ${LATER} }`, 'lookup(local.l, "a", "d")'],
    ['a group a for may keep', `{ for k, v in (${BOTH_KEY}) : k => v... if ${LATER} }`, 'lookup(local.l, "a", ["d"])'],
    ['a place only a mark that it may be sensitive names', `[for v in [for w in (${LATER} ? tolist([sensitive("x")]) : tolist([])) : w] : sensitive(v)]`, 'local.l'],
    ['a key only a mark that it may be sensitive names', `{ for k, v in { for k, w in { a = sensitive("x") } : k => w if ${LATER} } : k => sensitive(v) }`, 'local.l'],
  ])('leaves issensitive not known at plan for %s, since the apply may drop it', async (_, local, value) => {
    const text = config(local, output(`issensitive(${value})`));
    const plan = await newOrchestrator().plan(text);
    expect(plan.outputs.o.new?.value).toBe(UNKNOWN);

    await apply(text);
    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o).toMatchObject({ value: false });
  });

  it('refuses at plan an attribute a provider makes from one that may be sensitive', async () => {
    const file = `resource "local_file" "f" {\n  path    = ${LATER} ? "${path.join(dir, 'a.txt')}" : sensitive("${path.join(dir, 'b.txt')}")\n  content = "x"\n}\n`;

    await expect(newOrchestrator().plan(config('1', file + output('local_file.f.id')))).rejects.toThrow(MAYBE_REFUSED);
  });

  it('leaves to the plan at validate a root output that may hold a sensitive value, since validate reads no state', async () => {
    await apply(config('1', ''));
    const text = config('1', output(`${LATER} ? sensitive("a") : "b"`));

    await expect(newOrchestrator().validate(text)).resolves.toBeUndefined();
    const plan = await newOrchestrator().plan(text);
    expect(plan.outputs.o.new?.value).toBe('b');
  });

  it.each(HIDDEN)('hides in an error a value it may hold, for %s', async (_, local, block, hidden) => {
    const failed = newOrchestrator().plan(config(local, block));

    await expect(failed).rejects.toThrow(hidden);
    await expect(failed).rejects.not.toThrow('secret');
  });

  it.each([
    ['count', `${EITHER} ? 1 : 2`, 'count'],
    ['for_each', `${EITHER} ? toset(["a"]) : toset([])`, 'for_each'],
  ])('leaves %s that may be sensitive not known at plan, so the plan refuses it before the apply', async (_, value, name) => {
    const text = `resource "random_string" "s" { length = 4 }\nresource "null_resource" "n" {\n  ${name} = ${value}\n}\n`;

    await expect(newOrchestrator().plan(text)).rejects.toThrow(`${name} must be known when planning`);
  });

  it('does not take a key a value only may hold for one every outcome holds', async () => {
    const modules = either('objects', '{}', '{ a = { b = sensitive("x"), c = "y" } }');
    const text = config(`${LATER} ? module.empty.o : module.full.o`, modules + output('lookup(local.l, "a", sensitive({ b = "x", c = "y" })).c'));

    await expect(newOrchestrator().plan(text)).rejects.toThrow(MAYBE_REFUSED);
  });

  it('does not take a place a list only may hold for one every outcome holds', async () => {
    const modules = either('strings', '[]', '["c", sensitive("d")]');
    const plan = await newOrchestrator().plan(config(`${LATER} ? module.empty.o : module.full.o`, modules + output('issensitive([for v in local.l : sensitive(v)])')));

    expect(plan.outputs.o.new?.value).toBe(UNKNOWN);
  });

  it('takes a known part a later argument of merge gives, beside a value sensitive somewhere', async () => {
    const modules = 'module "m" {\n  source = "./merge"\n  x = local.l\n}\nresource "null_resource" "n" {\n  count = module.m.c\n}\n';

    await apply(config(`${LATER} ? { a = sensitive("x"), b = "y" } : { a = "z", b = sensitive("w") }`, modules + output('module.m.c')));

    const state = await new LocalBackend(dir).read();
    expect(Object.keys(state.resources).filter((address) => address.startsWith('null_resource'))).toEqual(['null_resource.n[0]', 'null_resource.n[1]']);
  });

  it('keeps no mark in state that only may have been, where the apply finds the part plain', async () => {
    await apply(merged(4));
    await apply(merged(5));

    const state = await new LocalBackend(dir).read();
    expect(state.resources['null_resource.n'].sensitive).toBeUndefined();
    const plan = await newOrchestrator().plan(merged(5));
    expect(plan.actions.filter((action) => action.type !== 'NO_OP')).toEqual([]);
  });

  const unnamed = `module "mp" {\n  source = "./map"\n  v = ${NOW} ? { k = sensitive("x"), j = "y" } : { k = "z", j = "y" }\n}\nlocals {\n  t = ${NOW} ? [sensitive("a"), "b"] : ["c", "d"]\n}\n`;

  it.each([
    ['a for over a list', `${NOW} ? tolist([sensitive("a"), "b"]) : tolist(["c", "d"])`, '[for v in local.l : v]'],
    ['an index not known yet into a list', `${NOW} ? tolist([sensitive("a"), "b"]) : tolist(["c", "d"])`, 'local.l[length(random_string.s.result) - 4]'],
    ['an index not known yet into a tuple', '1', 'local.t[length(random_string.s.result) - 4]'],
    ['a for over a map', '1', '{ for k, v in module.mp.o : k => v }'],
    ['merge of a map', '1', 'merge(module.mp.o, {})'],
    ['lookup in a map with a key not known yet', '1', `lookup(module.mp.o, ${NOW} ? "k" : "j", "d")`],
    ['an index not known yet into a map', '1', `module.mp.o[${NOW} ? "k" : "j"]`],
    [
      'an index not known yet into a list whose every outcome marks the item it reads',
      `${LATER} ? tolist([sensitive("a"), "b"]) : tolist([sensitive("c"), "d"])`,
      'local.l[length(random_string.s.result) - 4]',
    ],
  ])('is refused at plan, where it reads an item the plan cannot name, for %s', async (_, local, value) => {
    await expect(newOrchestrator().plan(config(local, unnamed + output(value)))).rejects.toThrow(MAYBE_REFUSED);
  });

  it('takes a part a later argument of merge gives, not known yet, beside a value sensitive somewhere', async () => {
    const counted = 'resource "null_resource" "n" {\n  count = length(merge(local.l, { c = ["1", random_string.s.result] }).c)\n}\n';
    const plan = await newOrchestrator().plan(config(`${LATER} ? { a = sensitive("x"), b = "y" } : { a = "z", b = sensitive("w") }`, counted));

    expect(plan.actions.filter((action) => action.resourceType === 'null_resource')).toHaveLength(2);
  });
});
