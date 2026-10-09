import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlanCommand } from '../../src/commands/plan';
import { createValidateCommand } from '../../src/commands/validate';

// A check reads no data source, and a plan with no state waits for the file to be made, so neither knows what this reads.
const waits = `resource "local_file" "a" {\n  path    = "a.txt"\n  content = "ab"\n}\ndata "local_file" "read" {\n  path = local_file.a.path\n}\n`;
const LATER = 'length(data.local_file.read.content)';

describe('validate with a count or for_each only an apply knows', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  const validate = async (config: string) => {
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
    await createValidateCommand().parseAsync(['node', 'clay']);
    return printed.join('\n');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-validate-unknown-'));
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    const record = (...args: unknown[]) => printed.push(args.join(' '));
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    // The command exits the process when it fails, which would take the test runner with it.
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('accepts such a count on a resource, and a reference to one of its instances', async () => {
    const config = `${waits}resource "null_resource" "n" {\n  count = ${LATER}\n}\noutput "first" { value = null_resource.n[0] }\noutput "all" { value = null_resource.n }`;

    expect(await validate(config)).toContain('Configuration is valid');
  });

  it.each([
    ['a set with a member not known yet', 'toset([data.local_file.read.content])'],
    ['a list with an item not known yet', '["a", data.local_file.read.content]'],
  ])('accepts a for_each on a resource that is %s', async (_, forEach) => {
    const config = `${waits}resource "local_file" "out" {\n  for_each = ${forEach}\n  path     = "\${each.key}.txt"\n  content  = each.value\n}\noutput "one" { value = local_file.out["a"].path }`;

    expect(await validate(config)).toContain('Configuration is valid');
  });

  it('accepts such a count on a data source, and a reference to one of its instances', async () => {
    const config = `${waits}data "local_file" "f" {\n  count = ${LATER}\n  path  = "f\${count.index}.txt"\n}\noutput "first" { value = data.local_file.f[0].content }\noutput "all" { value = data.local_file.f }`;

    expect(await validate(config)).toContain('Configuration is valid');
  });

  it('accepts such a count on a module call, and a reference to one of its instances', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(
      path.join(dir, 'm', 'main.clay'),
      'variable "text" {}\nresource "local_file" "in" {\n  path    = "in.txt"\n  content = var.text\n}\noutput "echo" { value = var.text }',
      'utf8'
    );
    const config = `${waits}module "m" {\n  source = "./m"\n  count  = ${LATER}\n  text   = "given"\n}\noutput "first" { value = module.m[0].echo }\noutput "all" { value = module.m }`;

    expect(await validate(config)).toContain('Configuration is valid');
  });

  it('accepts such a for_each on a module call', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'variable "text" {}\noutput "echo" { value = var.text }', 'utf8');
    const config = `${waits}module "m" {\n  source   = "./m"\n  for_each = toset([data.local_file.read.content])\n  text     = each.key\n}\noutput "one" { value = module.m["a"].echo }`;

    expect(await validate(config)).toContain('Configuration is valid');
  });

  it('accepts such a for_each on a data source, and a reference to one of its instances', async () => {
    const config = `${waits}data "local_file" "f" {\n  for_each = toset([data.local_file.read.content])\n  path     = "\${each.key}.txt"\n}\noutput "one" { value = data.local_file.f["a"].content }\noutput "all" { value = data.local_file.f }`;

    expect(await validate(config)).toContain('Configuration is valid');
  });

  it('accepts a for_each that is a whole map not known yet, every instance of such a module call', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'variable "text" {}\noutput "echo" { value = var.text }', 'utf8');
    const call = `module "m" {\n  source   = "./m"\n  for_each = toset([data.local_file.read.content])\n  text     = each.key\n}\n`;
    const config = `${waits}${call}resource "local_file" "out" {\n  for_each = module.m\n  path     = "\${each.key}.txt"\n  content  = each.value.echo\n}`;

    expect(await validate(config)).toContain('Configuration is valid');
  });

  it.each([
    ['count', 'local_file.out[0].path', `count   = ${LATER}\n  path    = "o\${count.index}.txt"`],
    ['for_each', 'local_file.out["a"].path', 'for_each = toset([data.local_file.read.content])\n  path    = "${each.key}.txt"'],
  ])('reads no data source that reads an instance of a resource with such a %s', async (_, reference, repeated) => {
    const config = `${waits}resource "local_file" "out" {\n  ${repeated}\n  content = "x"\n}\ndata "local_file" "g" {\n  path = ${reference}\n}`;

    expect(await validate(config)).toContain('Configuration is valid');
  });

  it.each([
    ['count', 'a string', 'data.local_file.read.content', 'count is a whole number from 0, not a string'],
    ['for_each', 'a string', 'data.local_file.read.content', 'for_each is a map, or a list or a set of strings, not a string'],
    ['for_each', 'a number', LATER, 'for_each is a map, or a list or a set of strings, not a number'],
  ])('refuses a %s not known yet whose type is %s', async (repetition, _, value, message) => {
    const config = `${waits}resource "null_resource" "n" {\n  ${repetition} = ${value}\n}`;

    expect(await validate(config)).toContain(message);
  });

  it('still checks the block that makes no instance, as it is written', async () => {
    const config = `${waits}resource "local_file" "out" {\n  count   = ${LATER}\n  path    = ["x"]\n  content = "x"\n}`;

    expect(await validate(config)).toContain('path is a tuple, where local_file takes a string');
  });

  it('still refuses a count that is known and wrong', async () => {
    const config = `${waits}resource "null_resource" "n" {\n  count = -1\n}`;

    expect(await validate(config)).toContain('count is a whole number from 0, not -1');
  });

  it('leaves the plan refusing it, since a plan has to name each instance', async () => {
    const config = `${waits}resource "null_resource" "n" {\n  count = ${LATER}\n}`;
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');

    await createPlanCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('count must be known when planning: it reads a value only an apply makes');
  });
});
