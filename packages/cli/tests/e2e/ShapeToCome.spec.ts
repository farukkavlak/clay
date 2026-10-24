import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

// Not known at plan, and true once the string is made.
const NOW = 'length(random_string.s.result) == 4';
// A list of one item at apply, of no type at plan: a for over a collection not known yet.
const ONE = `[for x in (${NOW} ? [1] : [1, 2]) : { k = "s" }]`;
const TWO = '[{ k = "s" }, { k = "s" }]';

const config = (local: string, extra = '') => `resource "random_string" "s" { length = 4 }
locals {
  l = ${local}
}
${extra}output "o" {
  value = { for v in local.l : "a" => v.k }
}
`;

describe('a value of no type yet joined with a structure', () => {
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
});
