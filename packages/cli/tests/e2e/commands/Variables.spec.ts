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

describe('values for root variables from --var and the environment', () => {
  let dir: string;

  const configure = (config: string) => fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');

  /** Runs with only `env` added to the environment, so a CLAY_VAR_ the test runner holds is not read. */
  const runIn = async (env: Record<string, string>, ...args: string[]): Promise<Ran> => {
    const outer = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLAY_VAR_')));
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, ...args], { cwd: dir, env: { ...outer, ...env } });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && typeof error.code === 'number')) throw error;

      const { code, stdout, stderr } = error as Error & Ran;
      return { code, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    }
  };

  const okIn = async (env: Record<string, string>, ...args: string[]) => {
    const ran = await runIn(env, ...args);
    expect(ran.stderr).toBe('');
    expect(ran.code).toBe(0);
    return ran.stdout;
  };

  const refusedIn = async (env: Record<string, string>, ...args: string[]) => {
    const ran = await runIn(env, ...args);
    expect(ran.code).toBe(1);
    return ran.stderr;
  };

  const ok = (...args: string[]) => okIn({}, ...args);
  const refused = (...args: string[]) => refusedIn({}, ...args);

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

    expect(await refused('plan')).toContain('variable "x" has no value; give it one with --var x=<value> or CLAY_VAR_x');
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

  it.each([
    ['a string as written', 'type = string', 'web', '"web"'],
    ['a number from its text', 'type = number', '5', '5'],
    ['a list as a constant', 'type = list(number)', '[80, 443]', '[80,443]'],
  ])('takes %s from CLAY_VAR_', async (_, type, text, value) => {
    await configure(`variable "x" {\n  ${type}\n}\noutput "o" { value = var.x }`);

    expect(shown(await okIn({ CLAY_VAR_x: text }, 'plan'))).toBe(value);
  });

  it('takes a value from CLAY_VAR_ over the default, and one from --var over both', async () => {
    await configure('variable "x" {\n  default = "d"\n}\noutput "o" { value = var.x }');

    expect(shown(await okIn({ CLAY_VAR_x: 'env' }, 'plan'))).toBe('"env"');
    expect(shown(await okIn({ CLAY_VAR_x: '[1' }, 'plan', '--var', 'x=flag'))).toBe('"flag"');
  });

  it('reads only CLAY_VAR_ and the name after it as written, so a name in other case is another one', async () => {
    await configure('variable "x" {\n  default = "d"\n}\noutput "o" { value = var.x }');

    expect(shown(await okIn({ CLAY_VAR_X: 'other', XLAY_VAR_x: 'other' }, 'plan'))).toBe('"d"');
  });

  it('does not read CLAY_VAR_ for a name the root does not declare, even one that is not a name', async () => {
    await configure('variable "x" {\n  default = "d"\n}\noutput "o" { value = var.x }');

    expect(shown(await okIn({ CLAY_VAR_y: '[1', 'CLAY_VAR_a-b': '1', CLAY_VAR_: '1' }, 'plan'))).toBe('"d"');
  });

  it('applies with a value from CLAY_VAR_', async () => {
    const target = path.join(dir, 'a.txt');
    await configure(`variable "x" {}\nresource "local_file" "a" {\n  path    = "${target}"\n  content = var.x\n}`);

    await okIn({ CLAY_VAR_x: 'hello' }, 'apply', '-y');

    expect(await fs.readFile(target, 'utf8')).toBe('hello');
  });

  it('keeps a value from CLAY_VAR_ in a saved plan, and no other the environment held', async () => {
    const target = path.join(dir, 'a.txt');
    await configure(`variable "x" {}\nresource "local_file" "a" {\n  path    = "${target}"\n  content = var.x\n}`);

    await okIn({ CLAY_VAR_x: 'saved', CLAY_VAR_other: 'secret' }, 'plan', '--out', 'plan.json');
    await okIn({ CLAY_VAR_x: 'later' }, 'apply', 'plan.json');

    expect(JSON.parse(await fs.readFile(path.join(dir, 'plan.json'), 'utf8')).variables).toEqual([{ from: 'env', name: 'x', text: 'saved' }]);
    expect(await fs.readFile(target, 'utf8')).toBe('saved');
  });

  it('refuses a value from CLAY_VAR_ that does not fit the type, placed at the environment variable', async () => {
    await configure('variable "x" {\n  type = number\n}\noutput "o" { value = var.x }');

    const stderr = await refusedIn({ CLAY_VAR_x: 'five' }, 'plan');

    expect(stderr).toContain('"five" is not a number');
    expect(stderr).toContain('on CLAY_VAR_x line 1, in variable "x":\n\n  1: five');
  });

  it('refuses a value from CLAY_VAR_ that reads a variable, as a default does', async () => {
    await configure('variable "x" {\n  type = list(string)\n}\nvariable "y" { default = "d" }');

    const stderr = await refusedIn({ CLAY_VAR_x: '[var.y]' }, 'apply', '-y');

    expect(stderr).toContain('A value given with CLAY_VAR_x is a constant, so it cannot hold var.y');
    expect(stderr).toContain('on CLAY_VAR_x line 1:\n\n  1: [var.y]');
  });

  it('plans a destroy with a value given, which it does not read', async () => {
    await configure('variable "x" {}');

    expect(await ok('plan', '--destroy', '--var', 'y=1')).toContain('No changes');
  });
});
