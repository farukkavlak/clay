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

  it('refuses a source that is not a local path, and points at it', async () => {
    const output = await validate('module "vpc" {\n  source = "terraform-aws-modules/vpc/aws"\n}');

    expect(output).toContain('Validation failed: module "vpc" has source "terraform-aws-modules/vpc/aws", which is not a local path: a source starts with ./ or ../\n');
    expect(output).toContain('on main.clay line 2, in module "vpc":');
  });

  it('refuses a module that is not there, and points at its source', async () => {
    const output = await validate('module "m" { source = "./missing" }');

    expect(output).toContain('Module source not found at: missing/main.clay');
    expect(output).toContain('on main.clay line 1, in module "m":');
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

  it('refuses a name an address could never read back, and points at it', async () => {
    const output = await validate('resource "local_file" "a.b" { path = "a.txt" content = "hi" }');

    expect(output).toContain('Invalid name "a.b"');
    expect(output).toContain('\n  1: resource "local_file" "a.b" { path = "a.txt" content = "hi" }\n                           ^');
  });

  it('refuses a reference with no attribute, and points at it', async () => {
    const output = await validate('resource "local_file" "f" {\n  path = "a.txt"\n  content = "${local_file.other}"\n}');

    expect(output).toContain('Resource reference must include attribute: local_file.other');
    expect(output).toContain('on main.clay line 3, in resource "local_file" "f":');
    expect(output).toContain('\n  3:   content = "${local_file.other}"\n                    ^');
  });

  // A data source is read as the configuration loads, so its values reach no scanner; a module is read through its outputs all the same.
  it('refuses a reference that reaches into a module from a data source', async () => {
    await fs.mkdir(path.join(dir, 'm'), { recursive: true });
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), `resource "local_file" "a" { path = "a.txt" content = "hi" }`, 'utf8');

    const output = await validate('module "m" { source = "./m" }\ndata "local_file" "d" { path = "${module.m.local_file.a}" }');

    expect(output).toContain('Output "local_file" not found in module');
    expect(output).toContain('on main.clay line 2, in data "local_file" "d":');
  });

  // The graph knows the name is missing; the place comes from the attribute that reads it, not from the block around it.
  it('points at a reference to a name the configuration never declares', async () => {
    const output = await validate('resource "local_file" "f" {\n  path    = "a.txt"\n  content = "${var.missing}"\n}');

    // The `in resource` line names the block, so the message does not.
    expect(output).toContain('Validation failed: variable "missing" is not defined\n');
    expect(output).toContain('on main.clay line 3, in resource "local_file" "f":');
    expect(output).toContain('\n  3:   content = "${var.missing}"\n                    ^');
  });

  it('refuses a reference that reads into a string, and points at it', async () => {
    const output = await validate('variable "v" { default = "x" }\noutput "o" { value = "${var.v.bogus}" }');

    expect(output).toContain('var.v is a string and cannot be read into');
    expect(output).toContain('\n  2: output "o" { value = "${var.v.bogus}" }\n                             ^');
  });

  it('refuses a reference with an empty part, rather than naming a target nobody wrote', async () => {
    const output = await validate('resource "local_file" "b" { content = "${local_file..id}" }');

    expect(output).toContain('Expect property name after dot.');
    expect(output).not.toContain('is not declared');
  });

  it('refuses a reference that names no variable', async () => {
    expect(await validate('output "o" { value = "${var}" }')).toContain('Variable reference must include a name: var');
  });

  it('refuses an attribute a variable block is never read for, and points at it', async () => {
    const output = await validate('variable "v" {\n  default     = "a"\n  descriptoin = "typo"\n}');

    expect(output).toContain('Variable "v" takes only "default", not "descriptoin".');
    expect(output).toContain('\n  3:   descriptoin = "typo"\n                     ^');
  });

  it('refuses a reference in a default its module call gives a value in place of, and points into the module', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'variable "x" {\n  default = var.nope\n}', 'utf8');

    const output = await validate('module "m" {\n  source = "./m"\n  x      = "given"\n}');

    expect(output).toContain("A variable's default is a constant, so it cannot hold var.nope");
    expect(output).toContain('on m/main.clay line 2:');
    expect(output).toContain('\n  2:   default = var.nope\n                 ^');
  });

  it('refuses a module that declares a variable its caller could never set, and points into the module', async () => {
    await fs.mkdir(path.join(dir, 'm'), { recursive: true });
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'variable "source" { default = "x" }', 'utf8');

    const output = await validate('module "m" { source = "./m" }');

    expect(output).toContain('"source" cannot be a variable name');
    expect(output).toContain('on m/main.clay line 1:');
  });

  // Only the engine makes the unknown marker, so a map spelled like it is checked like any other value.
  it('checks a resource that holds a map spelled like the unknown marker', async () => {
    const output = await validate('resource "local_file" "a" {\n  path    = "a.txt"\n  content = { "@@clay/unknown" = true }\n}');

    expect(output).toContain('content is an object, where local_file takes a string');
  });

  it('refuses a variable with no value', async () => {
    expect(await validate('variable "name" {}')).toContain('variable "name" has no value');
  });

  it('refuses a value the provider will not take, and points at the block', async () => {
    const output = await validate('resource "random_string" "pw" { length = 0 }');

    expect(output).toContain('random_string requires "length"');
    expect(output).toContain('on main.clay line 1, in resource "random_string" "pw":');
  });

  it('names the module instance an error came from, since one module file serves every call of it', async () => {
    await fs.mkdir(path.join(dir, 'm'), { recursive: true });
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'resource "random_string" "pw" { length = "eight" }', 'utf8');

    const output = await validate('module "a" { source = "./m" }\nmodule "b" { source = "./m" }');

    expect(output).toContain('on m/main.clay line 1, in resource "random_string" "pw":');
    expect(output).toContain('\n  in module.a');
  });

  it('says nothing about a module when the error is in the root configuration', async () => {
    const output = await validate('resource "random_string" "pw" { length = "eight" }');

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

    const output = await validate(config);

    expect(output).toContain('Dependency cycle detected');
    expect(output).toContain('on main.clay line 2, in resource "local_file" "a":');
  });

  it('refuses a syntax error and shows the line it is on', async () => {
    const output = await validate('resource "local_file" {');

    expect(output).toContain('on main.clay line 1:');
    expect(output).toContain('\n  1: resource "local_file" {\n                           ^');
  });

  it('refuses a string never closed on its line, and points at its quote rather than a quote further down', async () => {
    const output = await validate('resource "local_file" "a" {\n  path = "a.txt\n  content = "hi"\n}\n');

    expect(output).toContain('This string is never closed on its line');
    expect(output).toContain('\n  2:   path = "a.txt\n              ^');
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
