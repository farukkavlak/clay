import { State } from '@clay/contracts';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clayOutput } from '../helpers';

const step = (command: string) => `  provisioner "local-exec" {\n    command = "${command}"\n  }\n`;

/** A file at `name` made first on a replace, with a provisioner that appends a line to log.txt. */
const createsFirst = (name: string) =>
  `resource "local_file" "f" {\n  path    = "${name}"\n  content = "x"\n  lifecycle {\n    create_before_destroy = true\n  }\n${step('echo made >> log.txt')}}\n`;

/** Both files replaced, and b reads a, so b's old object goes before a's; b appends a line to log.txt when made. */
const readerReplaced = (suffix: string) =>
  `resource "local_file" "a" {\n  path    = "a${suffix}.txt"\n  content = "x"\n}\n` +
  `resource "local_file" "b" {\n  path    = "b${suffix}.txt"\n  content = local_file.a.path\n${step('echo made >> log.txt')}}\n`;

describe('a local-exec provisioner', () => {
  let dir: string;

  const clayIn = (...args: string[]) => clayOutput(dir, ...args);
  const file = (name: string) => path.join(dir, name);
  const read = (name: string) => fs.readFile(file(name), 'utf8');
  const write = (config: string) => fs.writeFile(file('main.clay'), config, 'utf8');
  const stateOf = async () => JSON.parse(await read('clay.state.json')) as State;

  /** What the command said on stderr, and the code it exited with. */
  const failure = async (...args: string[]): Promise<{ stderr: string; code: number }> => {
    try {
      await clayIn(...args);
    } catch (error) {
      const { stderr, code } = error as { stderr: string; code: number };
      return { stderr: stripVTControlCharacters(stderr), code };
    }

    throw new Error('Expected the command to fail');
  };

  /** A file whose content is `content`, and a provisioner on it that appends a line to log.txt. */
  const logged = (name: string, content: string) =>
    write(`resource "local_file" "f" {\n  path    = "${name}"\n  content = "${content}"\n  provisioner "local-exec" {\n    command = "echo made >> log.txt"\n  }\n}\n`);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-local-exec-'));
    await clayIn('init');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('runs after the create, once what it reads is made, and the resource keeps it as a dependency', async () => {
    await write(
      'resource "local_file" "a" {\n  path    = "a.txt"\n  content = "hello"\n}\n' +
        'resource "null_resource" "n" {\n  provisioner "local-exec" {\n    command = "cat ${local_file.a.path} > copy.txt"\n  }\n}\n'
    );

    await clayIn('apply', '--yes');

    const state = await stateOf();
    expect(await read('copy.txt')).toBe('hello');
    expect(state.resources['null_resource.n'].dependencies).toEqual(['local_file.a']);
  });

  it('does not run on an update', async () => {
    await logged('a.txt', 'one');
    await clayIn('apply', '--yes');
    await logged('a.txt', 'two');

    await clayIn('apply', '--yes');

    expect(await read('a.txt')).toBe('two');
    expect(await read('log.txt')).toBe('made\n');
  });

  it('runs again on a replace', async () => {
    await logged('a.txt', 'one');
    await clayIn('apply', '--yes');
    await logged('b.txt', 'one');

    await clayIn('apply', '--yes');

    expect(await read('log.txt')).toBe('made\nmade\n');
  });

  it('runs again on a replace that makes the new object first', async () => {
    await write(createsFirst('a.txt'));
    await clayIn('apply', '--yes');
    await write(createsFirst('b.txt'));

    await clayIn('apply', '--yes');

    expect(await read('log.txt')).toBe('made\nmade\n');
  });

  it('runs again on a replace whose old object is destroyed before its turn', async () => {
    await write(readerReplaced('1'));
    await clayIn('apply', '--yes');
    await write(readerReplaced('2'));

    await clayIn('apply', '--yes');

    expect(await read('log.txt')).toBe('made\nmade\n');
  });

  it('is checked again at apply, once a value only the apply knows is known', async () => {
    await write(
      'resource "command_exec" "e" {\n  command = "printf %s \\"\\""\n}\n' +
        'resource "null_resource" "n" {\n  provisioner "local-exec" {\n    command = command_exec.e.stdout\n  }\n}\n'
    );

    const { stderr } = await failure('apply', '--yes');

    const state = await stateOf();
    expect(stderr).toContain('null_resource.n: local-exec "command" must not be empty');
    expect(state.resources['null_resource.n'].tainted).toBe(true);
  });

  it.each([
    ['null as the command', '  provisioner "local-exec" {\n    command = null\n  }\n', 'local-exec requires "command"', 'line 10', '    command = null'],
    ['a key the value does not have', '  provisioner "local-exec" {\n    command = var.m["b"]\n  }\n', 'var.m has no key "b"', 'line 10', '    command = var.m["b"]'],
    [
      'an empty command another block gives',
      '  provisioner "local-exec" {\n    command = local_file.a.content\n  }\n',
      'local-exec "command" must not be empty',
      'line 9',
      '  provisioner "local-exec" {',
    ],
  ])('is refused by plan for %s, where it is written', async (_, body, message, line, source) => {
    const declared = 'variable "m" {\n  default = { a = "x" }\n}\n' + 'resource "local_file" "a" {\n  path    = "a.txt"\n  content = ""\n}\n';
    await write(`${declared}resource "null_resource" "n" {\n${body}}\n`);

    const { stderr } = await failure('plan');

    expect(stderr).toContain(message);
    expect(stderr).toContain(`${line}, in resource "null_resource" "n"`);
    expect(stderr).toContain(source);
  });

  it('runs once for each instance, reading its own count.index', async () => {
    await write('resource "null_resource" "n" {\n  count = 2\n  provisioner "local-exec" {\n    command = "echo ${count.index} > ${count.index}.txt"\n  }\n}\n');

    await clayIn('apply', '--yes');

    expect([await read('0.txt'), await read('1.txt')]).toEqual(['0\n', '1\n']);
  });

  it('runs each in the order written, stops at one that fails, and leaves the object tainted', async () => {
    await write(`resource "null_resource" "n" {\n${step('echo 1 >> log.txt')}${step('exit 3')}${step('echo 3 >> log.txt')}}\n`);

    const { stderr, code } = await failure('apply', '--yes');

    const state = await stateOf();
    expect(code).toBe(1);
    expect(stderr).toContain('null_resource.n: local-exec failed: Command failed: exit 3');
    expect(await read('log.txt')).toBe('1\n');
    expect(state.resources['null_resource.n'].tainted).toBe(true);
  });

  it('is run again by the next apply, which replaces the tainted object and leaves the new one whole', async () => {
    await write('resource "null_resource" "n" {\n  provisioner "local-exec" {\n    command = "test -f ready || exit 3"\n  }\n}\n');
    await failure('apply', '--yes');
    const before = await stateOf();
    await fs.writeFile(file('ready'), '', 'utf8');

    await clayIn('apply', '--yes');

    const after = await stateOf();
    expect(after.resources['null_resource.n'].tainted).toBeUndefined();
    expect(after.resources['null_resource.n'].attributes.id).not.toBe(before.resources['null_resource.n'].attributes.id);
  });

  it('does not show why it failed when a value given to it is sensitive', async () => {
    await write(
      'variable "token" {\n  default   = "s3cr3t-token"\n  sensitive = true\n}\n' +
        'resource "null_resource" "n" {\n  provisioner "local-exec" {\n    command = "false ${var.token}"\n  }\n}\n'
    );

    const { stderr } = await failure('apply', '--yes');

    expect(stderr).toContain('local-exec failed to run; a value given to it is sensitive, so the reason is not shown');
    expect(stderr).not.toContain('s3cr3t-token');
  });

  it.each([
    ['a type no provisioner has', '  provisioner "remote" {}\n', 'There is no provisioner "remote"', 'line 2', '  provisioner "remote" {}'],
    ['an argument local-exec does not take', '  provisioner "local-exec" {\n    when = "destroy"\n  }\n', 'local-exec has no attribute "when"', 'line 3', '    when = "destroy"'],
    ['no command', '  provisioner "local-exec" {}\n', 'local-exec requires "command"', 'line 2', '  provisioner "local-exec" {}'],
    ['a command that is not a string', '  provisioner "local-exec" {\n    command = ["a"]\n  }\n', 'command', 'line 3', '    command = ["a"]'],
    ['an empty command', '  provisioner "local-exec" {\n    command = ""\n  }\n', 'local-exec "command" must not be empty', 'line 2', '  provisioner "local-exec" {'],
    [
      'a resource no block declares',
      '  provisioner "local-exec" {\n    command = local_file.missing.path\n  }\n',
      'local_file.missing',
      'line 3',
      '    command = local_file.missing.path',
    ],
  ])('is refused by validate for %s, where it is written', async (_, body, message, line, source) => {
    await write(`resource "null_resource" "n" {\n${body}}\n`);

    const { stderr } = await failure('validate');

    expect(stderr).toContain(message);
    expect(stderr).toContain(`${line}, in resource "null_resource" "n"`);
    expect(stderr).toContain(source);
  });
});
