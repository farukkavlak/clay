import { Address } from '@clay/contracts';
import { LocalBackend } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalProvider } from '@clay/provider-local';

import { clayOutput, errorOf, orchestratorIn, placeOf } from '../helpers';
import { start } from '../start';

const imported = (to: string, id: string) => `import {\n to = ${to}\n id = "${id}"\n}\n`;

describe('an import block', () => {
  let dir: string;
  let file: string;

  const resource = (name: string, content = 'kept', head = '', at = file) => `resource "local_file" "${name}" {\n ${head}\n path = "${at}"\n content = "${content}"\n}\n`;

  const apply = async (config: string) => {
    for await (const event of start(orchestratorIn(dir), config)) if (event.type === 'failed') throw event.error;
  };

  const planned = async (config: string) => {
    const { actions } = await orchestratorIn(dir).plan(config);
    return actions.map((action) => [action.type, Address.of(action).toString(), action.importedFrom]);
  };

  const held = async () => {
    const { resources } = await new LocalBackend(dir).read();
    return resources;
  };

  const refusal = async (config: string) => {
    const error = await errorOf(() => orchestratorIn(dir).plan(config));
    return [error.message, error.position.line];
  };

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-import-')));
    file = path.join(dir, 'f.txt');
    await fs.writeFile(file, 'kept', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('takes over a file that matches the configuration, and leaves it as it is', async () => {
    const config = resource('a') + imported('local_file.a', file);

    expect(await planned(config)).toEqual([['NO_OP', 'local_file.a', file]]);
    await apply(config);
    const resources = await held();
    expect(resources['local_file.a']).toMatchObject({ resourceType: 'local_file', name: 'a', attributes: { id: file, path: file, content: 'kept' } });
    expect(await fs.readFile(file, 'utf8')).toBe('kept');
  });

  it('updates what it took over to the configuration, in the same apply', async () => {
    const config = resource('a', 'new') + imported('local_file.a', file);

    expect(await planned(config)).toEqual([['UPDATE', 'local_file.a', file]]);
    await apply(config);
    expect(await fs.readFile(file, 'utf8')).toBe('new');
    const resources = await held();
    expect(resources['local_file.a'].attributes).toMatchObject({ content: 'new' });
  });

  it('imports nothing once the state holds the address, so the block can stay', async () => {
    const config = resource('a') + imported('local_file.a', file);
    await apply(config);

    expect(await planned(config)).toEqual([['NO_OP', 'local_file.a', undefined]]);
  });

  it('imports to an instance of a counted resource', async () => {
    const config = resource('a', 'kept', 'count = 1') + imported('local_file.a[0]', file);

    expect(await planned(config)).toEqual([['NO_OP', 'local_file.a[0]', file]]);
    await apply(config);
    expect(Object.keys(await held())).toEqual(['local_file.a[0]']);
  });

  it('imports nothing where a count that came moves the state to the address', async () => {
    await apply(resource('a'));
    const config = resource('a', 'kept', 'count = 1') + imported('local_file.a[0]', file);
    const { actions } = await orchestratorIn(dir).plan(config);

    expect(actions.map((action) => [action.type, Address.of(action).toString(), action.movedFrom, action.importedFrom])).toEqual([
      ['NO_OP', 'local_file.a[0]', 'local_file.a', undefined],
    ]);
  });

  it('imports nothing where a count that went moves the state to the address', async () => {
    await apply(resource('a', 'kept', 'count = 1'));
    const config = resource('a') + imported('local_file.a', file);
    const { actions } = await orchestratorIn(dir).plan(config);

    expect(actions.map((action) => [action.type, Address.of(action).toString(), action.movedFrom, action.importedFrom])).toEqual([
      ['NO_OP', 'local_file.a', 'local_file.a[0]', undefined],
    ]);
  });

  it.each([
    ['marks a value sensitive', `variable "c" {\n default = "kept"\n sensitive = true\n}\nresource "local_file" "a" {\n path = "PATH"\n content = var.c\n}\n`],
    ['prevents its destroy', `resource "local_file" "a" {\n path = "PATH"\n content = "kept"\n lifecycle {\n prevent_destroy = true\n }\n}\n`],
  ])('shows an import that changes nothing as no change where the block %s', async (_, block) => {
    await fs.writeFile(path.join(dir, 'main.clay'), block.replace('PATH', file) + imported('local_file.a', file), 'utf8');

    const plan = await clayOutput(dir, 'plan');
    expect(plan).toContain(`<- local_file.a will be imported from ${JSON.stringify(file)}`);
    expect(plan).toContain('Plan: 0 to add, 0 to change, 0 to destroy, 1 to import.');
  });

  it('refuses an object its provider finds but cannot read back', async () => {
    const unread = Object.assign(new LocalProvider(), { read: async () => null });
    const config = resource('a') + imported('local_file.a', file);
    const error = await errorOf(() => orchestratorIn(dir, unread).plan(config));

    expect([error.message, error.position.line]).toEqual([`import to local_file.a found no local_file with the id "${file}"`, placeOf(config, 'import {').line]);
  });

  it('keeps the marks of the block on what it took over', async () => {
    const config = `variable "p" {\n default = "${file}"\n sensitive = true\n}\nresource "local_file" "a" {\n path = var.p\n content = "kept"\n}\n${imported('local_file.a', file)}`;
    const plan = await orchestratorIn(dir).plan(config);

    expect(plan.imported['local_file.a'].sensitive).toEqual([['id'], ['path']]);
  });

  it.each([
    ['nothing at the id', () => resource('a') + imported('local_file.a', '/no/such/file.txt'), 'import to local_file.a found no local_file with the id "/no/such/file.txt"'],
    [
      'a type that cannot be imported',
      () => 'resource "null_resource" "a" {}\n' + imported('null_resource.a', 'x'),
      'import to null_resource.a, but null_resource cannot be imported',
    ],
    ['no block for the address', () => resource('a') + imported('local_file.b', file), 'import to local_file.b, but the root module declares no resource "local_file" "b"'],
    [
      'a key on a resource with neither count nor for_each',
      () => resource('a') + imported('local_file.a[0]', file),
      'import to local_file.a[0], but resource "local_file" "a" has neither count nor for_each, so it takes no key',
    ],
    [
      'no key on a counted resource',
      () => resource('a', 'kept', 'count = 1') + imported('local_file.a', file),
      'import to local_file.a, but resource "local_file" "a" has count, so an instance is named by a number, as in [0]',
    ],
    [
      'a string key on a counted resource',
      () => resource('a', 'kept', 'count = 1') + imported('local_file.a["x"]', file),
      'import to local_file.a["x"], but resource "local_file" "a" has count, so an instance is named by a number, as in [0]',
    ],
    [
      'a number key on a resource with for_each',
      () => resource('a', 'kept', 'for_each = toset(["x"])') + imported('local_file.a[0]', file),
      'import to local_file.a[0], but resource "local_file" "a" has for_each, so an instance is named by a string, as in ["a"]',
    ],
    [
      'an instance the count does not make',
      () => resource('a', 'kept', 'count = 1') + imported('local_file.a[1]', file),
      'import to local_file.a[1], but the configuration makes no such instance',
    ],
  ])('refuses %s at the import block', async (_, config, message) => {
    const written = config();

    expect(await refusal(written)).toEqual([message, placeOf(written, 'import {').line]);
    expect(await held()).toEqual({});
  });

  it('names the first import that finds nothing in the order the resources are planned, as any other refusal', async () => {
    const config = resource('a') + resource('b', 'kept', '', path.join(dir, 'g.txt')) + imported('local_file.b', '/no/b.txt') + imported('local_file.a', '/no/a.txt');

    expect(await refusal(config)).toEqual(['import to local_file.a found no local_file with the id "/no/a.txt"', placeOf(config, imported('local_file.a', '/no/a.txt')).line]);
  });

  it('refuses a type that cannot be imported in validate too, before any provider is asked', async () => {
    const config = 'resource "null_resource" "a" {}\n' + imported('null_resource.a', 'x');
    const error = await errorOf(() => orchestratorIn(dir).validate(config));

    expect([error.message, error.position.line]).toEqual(['import to null_resource.a, but null_resource cannot be imported', 2]);
  });

  it('refuses an import block in a module another calls', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    const inside = resource('a') + imported('local_file.a', file);
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), inside, 'utf8');
    const error = await errorOf(() => orchestratorIn(dir).plan('module "m" {\n source = "./m"\n}\n'));

    expect([error.message, error.position.file, error.position.line]).toEqual([
      'import is taken only in the root module',
      path.join('m', 'main.clay'),
      placeOf(inside, 'import {').line,
    ]);
  });

  it('refuses a file another resource already holds, which each would write over', async () => {
    await apply(resource('a'));
    const config = resource('a') + resource('b') + imported('local_file.b', file);

    const error = await errorOf(() => orchestratorIn(dir).plan(config));
    expect(error.message).toContain(`local_file.b and local_file.a are both the file ${file}`);
  });

  it('refuses a saved plan whose import the configuration no longer makes', async () => {
    const other = path.join(dir, 'g.txt');
    await fs.writeFile(other, 'kept', 'utf8');
    const engine = orchestratorIn(dir);
    const plan = await engine.plan(resource('a') + imported('local_file.a', file));

    const run = async () => {
      for await (const event of engine.runPlan(plan, resource('a') + imported('local_file.a', other))) if (event.type === 'failed') throw event.error;
    };
    await expect(run()).rejects.toThrow(`The saved plan imports local_file.a from "${file}", which the configuration does not. Plan again.`);
    expect(await held()).toEqual({});
  });

  it('shows the import in the plan and counts it, and again after the apply', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), resource('a', 'new') + imported('local_file.a', file), 'utf8');

    const plan = await clayOutput(dir, 'plan', '--out', 'tfplan');
    expect(plan).toContain(`~ local_file.a will be updated, imported from ${JSON.stringify(file)}`);
    expect(plan).toContain('Plan: 0 to add, 1 to change, 0 to destroy, 1 to import.');

    const applied = await clayOutput(dir, 'apply', 'tfplan');
    expect(applied).toContain(`~ local_file.a updated, imported from ${JSON.stringify(file)}`);
    expect(applied).toContain('0 added, 1 changed, 0 destroyed, 1 imported');
  });

  it('shows an import that changes nothing as its own line', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), resource('a') + imported('local_file.a', file), 'utf8');

    const plan = await clayOutput(dir, 'plan');
    expect(plan).toContain(`<- local_file.a will be imported from ${JSON.stringify(file)}`);
    expect(plan).toContain('Plan: 0 to add, 0 to change, 0 to destroy, 1 to import.');
  });
});
