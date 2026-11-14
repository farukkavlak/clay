import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clay } from '../helpers';

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** The output the plan shows for `o`. */
const shown = (stdout: string) => /\+ o = (.*)/.exec(stdout)?.[1];

describe('values for root variables from --var', () => {
  let dir: string;

  const configure = (config: string) => fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');

  const run = async (...args: string[]): Promise<Ran> => {
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && typeof error.code === 'number')) throw error;

      const { code, stdout, stderr } = error as Error & Ran;
      return { code, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    }
  };

  const ok = async (...args: string[]) => {
    const ran = await run(...args);
    expect(ran.stderr).toBe('');
    expect(ran.code).toBe(0);
    return ran.stdout;
  };

  const refused = async (...args: string[]) => {
    const ran = await run(...args);
    expect(ran.code).toBe(1);
    return ran.stderr;
  };

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-variables-')));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['a string as written', 'type = string', 'web', '"web"'],
    ['text with no type as written, even one that looks like a list', '', '[1]', '"[1]"'],
    ['text that holds = and ${ as written', '', 'a=${b}', '"a=${b}"'],
    ['an empty text', 'type = string', '', '""'],
    ['a number from its text', 'type = number', '5', '5'],
    ['a bool from its text', 'type = bool', 'true', 'true'],
    ['a list as a constant', 'type = list(number)', '[80, 443]', '[80,443]'],
    ['an object as a constant', 'type = object({ name = string })', '{ name = "web" }', '{"name":"web"}'],
  ])('takes %s', async (_, type, text, value) => {
    await configure(`variable "x" {\n  ${type}\n}\noutput "o" { value = var.x }`);

    expect(shown(await ok('plan', '--var', `x=${text}`))).toBe(value);
  });

  it('takes the last value given for a name, and reads none before it', async () => {
    await configure('variable "x" {\n  type = list(number)\n}\noutput "o" { value = var.x }');

    expect(shown(await ok('plan', '--var', 'x=[1', '--var', 'x=[2]'))).toBe('[2]');
  });

  it('takes a value over the default', async () => {
    await configure('variable "x" {\n  default = "d"\n}\noutput "o" { value = var.x }');

    expect(shown(await ok('plan', '--var', 'x=given'))).toBe('"given"');
  });

  it('applies with the value given', async () => {
    const target = path.join(dir, 'a.txt');
    await configure(`variable "x" {}\nresource "local_file" "a" {\n  path    = "${target}"\n  content = var.x\n}`);

    await ok('apply', '-y', '--var', 'x=hello');

    expect(await fs.readFile(target, 'utf8')).toBe('hello');
  });

  it('applies a saved plan with the values it was made with', async () => {
    const target = path.join(dir, 'a.txt');
    await configure(`variable "x" {}\nresource "local_file" "a" {\n  path    = "${target}"\n  content = var.x\n}`);

    await ok('plan', '--var', 'x=saved', '--out', 'plan.json');
    await ok('apply', 'plan.json');

    expect(await fs.readFile(target, 'utf8')).toBe('saved');
  });

  it('refuses a value for a saved plan, which keeps its own', async () => {
    await configure('variable "x" {}\noutput "o" { value = var.x }');
    await ok('plan', '--var', 'x=saved', '--out', 'plan.json');

    expect(await refused('apply', 'plan.json', '--var', 'x=other')).toContain('--var is for a plan: a saved plan is applied with the values it was made with');
  });

  it('refuses a variable with no value, and says how to give one', async () => {
    await configure('variable "x" {}');

    expect(await refused('plan')).toContain('variable "x" has no value; give it one with --var x=<value>');
  });

  it('refuses a value for a variable the root does not declare', async () => {
    await configure('variable "x" { default = "d" }');

    expect(await refused('plan', '--var', 'y=1')).toContain('--var gives a value to "y", which the root module does not declare as a variable');
  });

  it.each([['x'], ['=1']])('refuses %s, which is not name=value', async (pair) => {
    await configure('variable "x" { default = "d" }');

    expect(await refused('plan', '--var', pair)).toContain(`option '--var <name=value>' argument '${pair}' is invalid. it takes name=value`);
  });

  it('refuses a value that does not parse, and shows where in it', async () => {
    await configure('variable "x" {\n  type = list(number)\n}');

    const stderr = await refused('plan', '--var', 'x=[1 2]');

    expect(stderr).toContain('on --var x line 1:');
    expect(stderr).toContain('  1: [1 2]\n        ^');
  });

  it.each([
    ['a variable', '[var.y]', 'var.y'],
    ['a function', '[upper("a")]', 'upper(...)'],
  ])('refuses a value that reads %s, as a default does', async (_, text, held) => {
    await configure('variable "x" {\n  type = list(string)\n}\nvariable "y" { default = "d" }');

    const stderr = await refused('plan', '--var', `x=${text}`);

    expect(stderr).toContain(`A value given with --var is a constant, so it cannot hold ${held}`);
    expect(stderr).toContain('on --var x line 1:');
  });

  it('refuses a value that does not fit the type, placed at the flag', async () => {
    await configure('variable "x" {\n  type = number\n}\noutput "o" { value = var.x }');

    const stderr = await refused('plan', '--var', 'x=five');

    expect(stderr).toContain('variable "x"');
    expect(stderr).toContain('on --var x line 1');
    expect(stderr).toContain('  1: five');
  });

  it('reads the text of a bool as it is, and refuses one that is not true or false', async () => {
    await configure('variable "x" {\n  type = bool\n}\noutput "o" { value = var.x }');

    const stderr = await refused('plan', '--var', 'x=yes');

    expect(stderr).toContain('"yes" is not a boolean');
    expect(stderr).toContain('on --var x line 1, in variable "x":');
  });

  it('reads the text for a variable of any type as a value written in the configuration', async () => {
    await configure('variable "x" {\n  type = any\n}\noutput "o" { value = var.x }');

    expect(shown(await ok('plan', '--var', 'x="web"'))).toBe('"web"');
    expect(await refused('plan', '--var', 'x=web')).toContain('A value given with --var is a constant, so it cannot hold web');
  });

  it('makes a value given to a sensitive variable sensitive', async () => {
    await configure('variable "x" {\n  sensitive = true\n}\noutput "o" { value = var.x }');

    expect(await refused('plan', '--var', 'x=secret')).toContain('output "o" holds a sensitive value');
  });

  it('places an error in a value given to apply at the flag, and shows the value', async () => {
    await configure('variable "x" {\n  type = number\n}\noutput "o" { value = var.x }');

    const stderr = await refused('apply', '-y', '--var', 'x=five');

    expect(stderr).toContain('"five" is not a number');
    expect(stderr).toContain('on --var x line 1, in variable "x":\n\n  1: five');
  });

  it('refuses a value a rule refuses, placed at the flag', async () => {
    const rule = '  validation {\n    condition     = var.x > 0\n    error_message = "x is ${var.x}"\n  }';
    await configure(`variable "x" {\n  type = number\n${rule}\n}\noutput "o" { value = var.x }`);

    const stderr = await refused('plan', '--var', 'x=-1');

    expect(stderr).toContain('variable "x": x is -1');
    expect(stderr).toContain('on --var x line 1');
  });

  it('plans a destroy with a value given, which it does not read', async () => {
    await configure('variable "x" {}');

    expect(await ok('plan', '--destroy', '--var', 'y=1')).toContain('No changes');
  });
});
