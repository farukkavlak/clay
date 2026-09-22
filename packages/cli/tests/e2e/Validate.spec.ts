import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createValidateCommand } from '../../src/commands/validate';

const echoModule = `variable "text" {}\noutput "echo" { value = "\${var.text}" }`;

describe('validate against real files', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  const validate = async (config: string) => {
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
    await createValidateCommand().parseAsync(['node', 'clay']);
    return printed.join('\n');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-validate-'));
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

  it('accepts a resource that reads another one', async () => {
    const config = `
      resource "local_file" "a" { path = "a.txt" content = "hi" }
      resource "local_file" "b" { path = "b.txt" content = local_file.a.content }
    `;

    const output = await validate(config);

    expect(output).not.toContain('failed');
    expect(output).toContain('Configuration is valid');
  });

  it('accepts a module and the outputs it feeds', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), echoModule, 'utf8');
    const config = `module "m" { source = "./m" text = "given" }\noutput "echo" { value = "\${module.m.echo}" }`;

    expect(await validate(config)).toContain('Configuration is valid');
  });

  it('refuses a module that is not there', async () => {
    expect(await validate('module "m" { source = "./missing" }')).toContain('Module source not found at: missing/main.clay');
  });

  it('refuses an input the module has no variable for, and points at the line it is written on', async () => {
    await fs.mkdir(path.join(dir, 'm'), { recursive: true });
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), echoModule, 'utf8');

    const output = await validate('module "m" {\n  source = "./m"\n  contnet = "typo"\n}');

    expect(output).toContain('module "m" has no variable "contnet"');
    expect(output).toContain('on main.clay line 3, in module "m":');
    // The caret sits under the value: an attribute name has no position of its own in the AST.
    expect(output).toContain('\n  3:   contnet = "typo"\n                 ^');
  });

  it('refuses a variable with no value', async () => {
    expect(await validate('variable "name" {}')).toContain('variable "name" has no value');
  });

  it('refuses a value the provider will not take, and points at the block', async () => {
    const output = await validate('resource "random_string" "pw" { length = "8" }');

    expect(output).toContain('random_string requires "length"');
    expect(output).toContain('on main.clay line 1, in resource "random_string" "pw":');
  });

  it('names the module instance an error came from, since one module file serves every call of it', async () => {
    await fs.mkdir(path.join(dir, 'm'), { recursive: true });
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'resource "random_string" "pw" { length = "8" }', 'utf8');

    const output = await validate('module "a" { source = "./m" }\nmodule "b" { source = "./m" }');

    expect(output).toContain('on m/main.clay line 1, in resource "random_string" "pw":');
    expect(output).toContain('\n  in module.a');
  });

  it('says nothing about a module when the error is in the root configuration', async () => {
    const output = await validate('resource "random_string" "pw" { length = "8" }');

    expect(output).not.toContain('in module.');
  });

  it('refuses a reference to a resource the configuration does not declare', async () => {
    expect(await validate(`output "o" { value = "\${local_file.nope.id}" }`)).toContain('"local_file.nope" is not declared');
  });

  it('refuses a dependency cycle', async () => {
    const config = `
      resource "local_file" "a" { path = "a" content = "\${local_file.b.content}" }
      resource "local_file" "b" { path = "b" content = "\${local_file.a.content}" }
    `;

    expect(await validate(config)).toContain('Dependency cycle detected');
  });

  it('refuses a syntax error and shows the line it is on', async () => {
    const output = await validate('resource "local_file" {');

    expect(output).toContain('on main.clay line 1:');
    expect(output).toContain('\n  1: resource "local_file" {\n                           ^');
  });

  it('names the module file a syntax error is in, not the root one', async () => {
    await fs.mkdir(path.join(dir, 'mod'), { recursive: true });
    await fs.writeFile(path.join(dir, 'mod', 'main.clay'), 'resource "local_file" {\n', 'utf8');

    const output = await validate('module "m" { source = "./mod" }');

    expect(output).toContain('on mod/main.clay line 1:');
  });

  it('says so when there is no configuration', async () => {
    await createValidateCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('main.clay not found in current directory');
  });

  it('writes nothing, not even a state file', async () => {
    await validate('resource "local_file" "a" { path = "a.txt" content = "hi" }');

    expect(await fs.readdir(dir)).toEqual(['main.clay']);
  });
});
