import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Where an error would point at the first `needle`. */
const placeOf = (config: string, needle: string) => {
  const before = config.slice(0, config.indexOf(needle)).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
};

const errorOf = async (run: () => Promise<unknown>): Promise<ConfigError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the configuration to be refused');
};

const BROKEN = 'tolist([1, true])';
const REFUSED = '[1, true]';
const CANNOT_JOIN = 'tolist cannot join a number and a boolean into one type';
const notList = (kind: string) => `tolist takes a list, a tuple or a set, not ${kind}`;

describe('every block read once, whatever instances it makes', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const writeModule = async (content: string) => {
    await fs.mkdir(path.join(dir, 'm'), { recursive: true });
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), content, 'utf8');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-read-once-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['count = 0', 'count    = 0'],
    ['an empty for_each', 'for_each = {}'],
  ])('refuses a broken value in a resource with %s', async (_, repeat) => {
    const config = `resource "local_file" "f" {\n  ${repeat}\n  path     = "f.txt"\n  content  = ${BROKEN}\n}`;

    const error = await errorOf(() => newOrchestrator().validate(config));

    expect(error.message).toBe(CANNOT_JOIN);
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, REFUSED) });
    expect(error.block).toBe('resource "local_file" "f"');
  });

  it.each([
    ['a broken value', BROKEN, REFUSED, CANNOT_JOIN],
    ['a value of the wrong type', '["x"]', '["x"]', 'path is a tuple, where local_file takes a string'],
  ])('refuses %s in a data source in a module that makes no instance', async (_, value, refused, message) => {
    const module = `data "local_file" "f" {\n  path = ${value}\n}`;
    await writeModule(module);

    const error = await errorOf(() => newOrchestrator().validate('module "m" {\n  source = "./m"\n  count  = 0\n}'));

    expect(error.message).toBe(message);
    expect(error.position).toEqual({ file: path.join('m', 'main.clay'), ...placeOf(module, refused) });
    expect(error.block).toBe('data "local_file" "f"');
  });

  it('refuses a broken input to a variable that names no type, given to a module call with count = 0', async () => {
    await writeModule('variable "a" {}');
    const config = `module "m" {\n  source = "./m"\n  count  = 0\n  a      = ${BROKEN}\n}`;

    const error = await errorOf(() => newOrchestrator().validate(config));

    expect(error.message).toBe(CANNOT_JOIN);
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, REFUSED) });
    expect(error.block).toBe('module "m"');
  });

  it.each([
    ['a resource', `resource "local_file" "f" {\n  path    = "f.txt"\n  content = ${BROKEN}\n}`, 'resource "local_file" "f"'],
    ['an output', `output "o" {\n  value = ${BROKEN}\n}`, 'output "o"'],
  ])('refuses a broken value in %s inside a module called with count = 0', async (_, module, block) => {
    await writeModule(module);

    const error = await errorOf(() => newOrchestrator().validate('module "m" {\n  source = "./m"\n  count  = 0\n}'));

    expect(error.message).toBe(CANNOT_JOIN);
    expect(error.position).toEqual({ file: path.join('m', 'main.clay'), ...placeOf(module, REFUSED) });
    expect(error.block).toBe(block);
  });

  it.each([
    ['a resource', `resource "local_file" "f" {\n  count   = length(${BROKEN})\n  path    = "f.txt"\n  content = "f"\n}`, 'resource "local_file" "f"'],
    ['a module call', `module "n" {\n  source = "./n"\n  count  = length(${BROKEN})\n}`, 'module "n"'],
  ])('refuses a broken count on %s inside a module called with count = 0', async (_, module, block) => {
    await writeModule(module);
    await fs.mkdir(path.join(dir, 'm', 'n'));
    await fs.writeFile(path.join(dir, 'm', 'n', 'main.clay'), '', 'utf8');

    const error = await errorOf(() => newOrchestrator().validate('module "m" {\n  source = "./m"\n  count  = 0\n}'));

    expect(error.message).toBe(CANNOT_JOIN);
    expect(error.position).toEqual({ file: path.join('m', 'main.clay'), ...placeOf(module, REFUSED) });
    expect(error.block).toBe(block);
  });

  it('refuses a broken call beside a reference, which is read as not known yet', async () => {
    const config = `resource "local_file" "f" {\n  count   = 0\n  path    = "f.txt"\n  content = "\${count.index}-\${${BROKEN}}"\n}`;

    const error = await errorOf(() => newOrchestrator().validate(config));

    expect(error.message).toBe(CANNOT_JOIN);
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, REFUSED) });
  });

  it.each([
    [
      'a variable as the type it names',
      'variable "port" {\n  type    = number\n  default = 80\n}\n',
      'length(var.port)',
      'length takes a string, a list, a tuple, a set, a map or an object, not a number',
    ],
    ['count.index as a number', '', 'length(count.index)', 'length takes a string, a list, a tuple, a set, a map or an object, not a number'],
    [
      'a resource attribute as the type its schema names',
      'resource "local_file" "a" {\n  path    = "a.txt"\n  content = "a"\n}\n',
      'tolist(local_file.a.content)',
      'tolist takes a list, a tuple or a set, not a string',
    ],
  ])('reads %s', async (_, before, read, message) => {
    const config = `${before}resource "local_file" "f" {\n  count   = 0\n  path    = "f.txt"\n  content = ${read}\n}`;

    const error = await errorOf(() => newOrchestrator().validate(config));

    expect(error.message).toBe(message);
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, read.slice(read.indexOf('(') + 1)) });
  });

  it('reads each.key as a string', async () => {
    const config = 'resource "local_file" "f" {\n  for_each = {}\n  path     = "f.txt"\n  content  = tolist(each.key)\n}';

    const error = await errorOf(() => newOrchestrator().validate(config));

    expect(error.message).toBe('tolist takes a list, a tuple or a set, not a string');
  });

  it('refuses an attribute a resource does not have, read from a block that makes no instance', async () => {
    const config =
      'resource "local_file" "a" {\n  path    = "a.txt"\n  content = "a"\n}\nresource "local_file" "f" {\n  count   = 0\n  path    = "f.txt"\n  content = local_file.a.nope\n}';

    const error = await errorOf(() => newOrchestrator().validate(config));

    expect(error.message).toBe('local_file has no attribute "nope"');
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, 'local_file.a.nope') });
  });

  it.each([
    [
      'a resource attribute',
      `resource "local_file" "f" {\n  count   = 0\n  path    = "f.txt"\n  content = [local_file.a.content]\n}`,
      'content is a tuple, where local_file takes a string',
    ],
    ['a module input', `module "m" {\n  source = "./m"\n  count  = 0\n  p      = [local_file.a.content]\n}`, 'p is a tuple, where variable "p" takes a number'],
  ])('holds %s that no instance reads to the type it is given to', async (_, block, message) => {
    await writeModule('variable "p" { type = number }');
    const config = `resource "local_file" "a" {\n  path    = "a.txt"\n  content = "a"\n}\n${block}`;

    const error = await errorOf(() => newOrchestrator().validate(config));

    expect(error.message).toBe(message);
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, '[local_file.a.content]') });
  });

  it.each([
    ['a list', `[for v in var.l : ${BROKEN}]`, REFUSED, CANNOT_JOIN],
    ['an object, its key', `{for v in var.l : ${BROKEN} => v}`, REFUSED, CANNOT_JOIN],
    ['a list, an item as its element type', '[for v in var.l : tolist(v)]', 'v)', notList('a string')],
    ['a list, an index as a number', '[for i, v in var.l : tolist(i)]', 'i)', notList('a number')],
    ['a set with a member not known yet', '[for v in toset([var.l[0], "b"]) : tolist(v)]', 'v)', notList('a string')],
    ['a set, a member as its own key', '[for k, v in toset([var.l[0], "b"]) : tolist(k)]', 'k)', notList('a string')],
    ['a list from a map, an item as its element type', '[for v in var.m : tolist(v)]', 'v)', notList('a string')],
    ['a list from a map, a key as a string', '[for k, v in var.m : tolist(k)]', 'k)', notList('a string')],
    ['a list from an object, a key as a string', '[for k, v in var.n : tolist(k)]', 'k)', notList('a string')],
  ])('reads the body of a for making %s once, over a collection not known yet', async (_, value, refused, message) => {
    const module = `variable "l" { type = list(string) }\nvariable "m" { type = map(string) }\nvariable "n" { type = object({ a = number }) }\noutput "o" {\n  value = ${value}\n}`;
    await writeModule(module);
    const config = 'module "m" {\n  source = "./m"\n  count  = 0\n  l      = ["a"]\n  m      = { a = "b" }\n  n      = { a = 1 }\n}';

    const error = await errorOf(() => newOrchestrator().validate(config));

    expect(error.message).toBe(message);
    expect(error.position).toEqual({ file: path.join('m', 'main.clay'), ...placeOf(module, refused) });
  });

  it.each([
    ['a data source as it was read', 'data.local_file.d.nope', 'Attribute "nope" not found on data source "data.local_file.d"'],
    ['a directory as the string it is', 'path.module.x', 'path.module is a string and cannot be read into'],
  ])('reads %s', async (_, read, message) => {
    await fs.writeFile(path.join(dir, 'd.txt'), 'd', 'utf8');
    const config = `data "local_file" "d" { path = ${JSON.stringify(path.join(dir, 'd.txt'))} }\nresource "local_file" "f" {\n  count   = 0\n  path    = "f.txt"\n  content = ${read}\n}`;

    const error = await errorOf(() => newOrchestrator().validate(config));

    expect(error.message).toBe(message);
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, read) });
  });

  it('accepts a block that makes no instance and reads only what it could take', async () => {
    await writeModule(
      'variable "names" { type = list(string) }\nvariable "any" {}\nresource "local_file" "f" {\n  count   = length(var.names)\n  path    = "${var.names[0]}-${count.index}.txt"\n  content = "${length(var.any)}-${var.any.deep[0]}-${tolist(var.any)[0]}"\n}\noutput "o" { value = [for n in var.names : tolist([n, 1])] }'
    );
    const config =
      'module "m" {\n  source = "./m"\n  count  = 0\n  names  = []\n  any    = {}\n}\nresource "local_file" "f" {\n  for_each = {}\n  path     = "${each.key}.txt"\n  content  = "${tolist(each.value)[0]}-${tolist(module.m[0].o)[0]}"\n}';

    const plan = await newOrchestrator().plan(config);

    expect(plan.actions).toEqual([]);
  });
});
