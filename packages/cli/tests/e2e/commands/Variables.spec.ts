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

describe('values for root variables from --var, variables files and the environment', () => {
  let dir: string;

  const configure = (config: string) => fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
  const write = (file: string, text: string) => fs.writeFile(path.join(dir, file), text, 'utf8');

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

    expect(await refused('plan')).toContain('variable "x" has no value; give it one with --var x=<value>, CLAY_VAR_x or clay.clayvars');
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

  it('plans a destroy with no value for a variable no provider block reads', async () => {
    await configure('variable "x" {}');

    expect(await ok('plan', '--destroy')).toContain('No changes');
  });

  it('takes --var in a destroy, and refuses one for a variable the root does not declare', async () => {
    await configure('variable "x" {}');

    expect(await ok('destroy', '-y', '--var', 'x=1')).toContain('No changes');
    expect(await refused('destroy', '-y', '--var', 'y=1')).toContain('--var gives a value to "y", which the root module does not declare as a variable');
  });

  it('destroys with no .clay file left, reading no value a clay.clayvars still gives', async () => {
    await configure(`variable "x" {}\nresource "local_file" "a" {\n  path = "${path.join(dir, 'b.txt')}"\n  content = var.x\n}`);
    await write('clay.clayvars', 'x = "hi"');
    await ok('apply', '-y');
    await fs.rm(path.join(dir, 'main.clay'));

    expect(await ok('destroy', '-y')).toContain('1 destroyed');
  });

  it('refuses a mistake in the values a destroy is given, as a plan does', async () => {
    await configure('variable "x" {}');
    await write('clay.clayvars', 'x = [');

    expect(await refused('plan', '--destroy')).toContain("Expect ']' after list.");
  });

  it('takes the values a --var-file holds, each as a value written in the configuration', async () => {
    await configure('variable "region" {\n  type = string\n}\nvariable "ports" {\n  type = list(number)\n}\noutput "o" { value = [var.region, var.ports] }');
    await write('prod.clayvars', 'region = "eu"\nports  = [80, 443]\n');

    expect(shown(await ok('plan', '--var-file', 'prod.clayvars'))).toBe('["eu",[80,443]]');
  });

  it('reads clay.clayvars on its own, over CLAY_VAR_', async () => {
    await configure('variable "x" {}\noutput "o" { value = var.x }');
    await write('clay.clayvars', 'x = "file"');

    expect(shown(await okIn({ CLAY_VAR_x: 'env' }, 'plan'))).toBe('"file"');
  });

  it.each([
    ['--var-file after --var', ['--var', 'x=flag', '--var-file', 'f.clayvars'], '"file"'],
    ['--var after --var-file', ['--var-file', 'f.clayvars', '--var', 'x=flag'], '"flag"'],
    ['--var-file over clay.clayvars', ['--var-file', 'f.clayvars'], '"file"'],
  ])('takes the value of %s', async (_, args, value) => {
    await configure('variable "x" {}\noutput "o" { value = var.x }');
    await write('clay.clayvars', 'x = "auto"');
    await write('f.clayvars', 'x = "file"');

    expect(shown(await ok('plan', ...args))).toBe(value);
  });

  it('applies with the values a file holds', async () => {
    const target = path.join(dir, 'a.txt');
    await configure(`variable "x" {}\nresource "local_file" "a" {\n  path    = "${target}"\n  content = var.x\n}`);
    await write('clay.clayvars', 'x = "hello"');

    await ok('apply', '-y');

    expect(await fs.readFile(target, 'utf8')).toBe('hello');
  });

  it('keeps the files a plan read in the saved plan, and reads them no more', async () => {
    const target = path.join(dir, 'a.txt');
    await configure(`variable "x" {}\nvariable "y" {}\nresource "local_file" "a" {\n  path    = "${target}"\n  content = "\${var.x}\${var.y}"\n}`);
    await write('clay.clayvars', 'x = "a"');
    await write('f.clayvars', 'y = "b"');

    await ok('plan', '--var-file', 'f.clayvars', '--out', 'plan.json');
    await write('clay.clayvars', 'x = "later"');
    await write('f.clayvars', 'y = "later"');
    await ok('apply', 'plan.json');

    expect(await fs.readFile(target, 'utf8')).toBe('ab');
  });

  it('refuses a --var-file for a saved plan, which keeps its own', async () => {
    await configure('variable "x" {}\noutput "o" { value = var.x }');
    await write('f.clayvars', 'x = "a"');
    await ok('plan', '--var-file', 'f.clayvars', '--out', 'plan.json');

    expect(await refused('apply', 'plan.json', '--var-file', 'nope.clayvars')).toContain('--var-file is for a plan: a saved plan is applied with the values it was made with');
  });

  it('refuses a --var-file that does not exist', async () => {
    await configure('variable "x" { default = "d" }');

    expect(await refused('plan', '--var-file', 'nope.clayvars')).toContain('Planning failed: nope.clayvars not found');
  });

  it.each([
    ['--var-file', ['--var-file', 'd']],
    ['clay.clayvars', []],
  ])('refuses a %s it cannot read, and exits 1', async (_, args) => {
    await configure('variable "x" { default = "d" }');
    await fs.mkdir(path.join(dir, args.length > 0 ? 'd' : 'clay.clayvars'));

    expect(await refused('plan', ...args)).toContain('Planning failed: EISDIR');
  });

  it('refuses a name given twice in a file', async () => {
    await configure('variable "x" {}');
    await write('f.clayvars', 'x = "a"\nx = "b"');

    const stderr = await refused('apply', '-y', '--var-file', 'f.clayvars');

    expect(stderr).toContain('"x" is given twice, first on line 1');
    expect(stderr).toContain('on f.clayvars line 2:');
  });

  it('refuses a name in a file the root does not declare, where it is written', async () => {
    await configure('variable "x" { default = "d" }');
    await write('f.clayvars', 'x = "a"\ny = "b"');

    const stderr = await refused('plan', '--var-file', 'f.clayvars');

    expect(stderr).toContain('"y" is given a value, but the root module does not declare it as a variable');
    expect(stderr).toContain('on f.clayvars line 2:\n\n  2: y = "b"');
  });

  it('refuses a value in a file that reads a name, as a default does', async () => {
    await configure('variable "x" {}');
    await write('clay.clayvars', 'x = eu');

    const stderr = await refused('plan');

    expect(stderr).toContain('A value in a variables file is a constant, so it cannot hold eu');
    expect(stderr).toContain('on clay.clayvars line 1:');
  });

  it('refuses a value in a file that does not fit the type, and shows the line', async () => {
    await configure('variable "port" {\n  type = number\n}\noutput "o" { value = var.port }');
    await write('f.clayvars', 'port = "five"');

    const stderr = await refusedIn({}, 'apply', '-y', '--var-file', 'f.clayvars');

    expect(stderr).toContain('"five" is not a number');
    expect(stderr).toContain('on f.clayvars line 1, in variable "port":\n\n  1: port = "five"');
  });

  it('reads a file whole, so a mistake in it is refused though a later value replaces the line', async () => {
    await configure('variable "x" {\n  type = list(number)\n}');
    await write('f.clayvars', 'x = [1');

    expect(await refused('plan', '--var-file', 'f.clayvars', '--var', 'x=[2]')).toContain('on f.clayvars line 1');
  });
});
