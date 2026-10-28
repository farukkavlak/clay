import { State } from '@clay/contracts';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clayOutput } from '../helpers';

/** A provisioner run before the object is destroyed, with the arguments written after `when`. */
const onDestroy = (args: string) => `  provisioner "local-exec" {\n    when    = destroy\n${args}  }\n`;
const command = (text: string) => `    command = "${text}"\n`;

/** A file at `name` holding `content`, with `body` inside its block. */
const fileWith = (name: string, content: string, body: string) => `resource "local_file" "f" {\n  path    = "${name}"\n  content = "${content}"\n${body}}\n`;

/** Both files replaced, and b reads a, so b's old object is destroyed before a's. */
const readerReplaced = (suffix: string) =>
  `resource "local_file" "a" {\n  path    = "a${suffix}.txt"\n  content = "x"\n}\n` +
  `resource "local_file" "b" {\n  path    = "b${suffix}.txt"\n  content = local_file.a.path\n${onDestroy(command('echo ${self.path} >> log.txt'))}}\n`;

/** A create-time provisioner that logs, and a destroy-time one whose command is `destroyed`. */
const madeThen = (destroyed: string) =>
  `resource "null_resource" "n" {\n  provisioner "local-exec" {\n${command('echo made >> log.txt')}  }\n${onDestroy(`    command = ${destroyed}\n`)}}\n`;

/** A null_resource whose trigger is what command_exec prints, and whose destroy-time command is that trigger. */
const readingStdout = (printed: string) =>
  `resource "command_exec" "e" {\n  command = "printf %s ${printed}"\n}\n` +
  `resource "null_resource" "n" {\n  triggers = { v = command_exec.e.stdout }\n${onDestroy('    command = self.triggers.v\n')}}\n`;

describe('a provisioner with when = destroy', () => {
  let dir: string;

  const clayIn = (...args: string[]) => clayOutput(dir, ...args);
  const file = (name: string) => path.join(dir, name);
  const read = (name: string) => fs.readFile(file(name), 'utf8');
  const write = (config: string) => fs.writeFile(file('main.clay'), config, 'utf8');
  const stateOf = async () => JSON.parse(await read('clay.state.json')) as State;

  /** What the command said on stdout and stderr, and the code it exited with. */
  const failure = async (...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
    try {
      await clayIn(...args);
    } catch (error) {
      const { stdout, stderr, code } = error as { stdout: string; stderr: string; code: number };
      return { stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr), code };
    }

    throw new Error('Expected the command to fail');
  };

  /** Applies `config`, then a configuration with no block left, so the object is destroyed. */
  const madeThenRemoved = async (config: string) => {
    await write(config);
    await clayIn('apply', '--yes');
    await write('');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-destroy-time-'));
    await clayIn('init');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not run when the object is made, and is kept in state as resolved through self', async () => {
    await write(fileWith('a.txt', 'one', onDestroy(command('echo ${self.content} >> log.txt'))));

    await clayIn('apply', '--yes');

    const state = await stateOf();
    expect(state.resources['local_file.f'].destroyProvisioners).toEqual([{ type: 'local-exec', config: { command: 'echo one >> log.txt' } }]);
    await expect(read('log.txt')).rejects.toThrow('ENOENT');
  });

  it('runs once the block is gone, before the object is destroyed, and prints as it runs', async () => {
    await madeThenRemoved(fileWith('a.txt', 'one', onDestroy(command('cat ${self.path} > seen.txt; echo said'))));

    const stdout = await clayIn('apply', '--yes');

    expect(await read('seen.txt')).toBe('one');
    await expect(read('a.txt')).rejects.toThrow('ENOENT');
    expect(stdout.indexOf('  local_file.f (local-exec): said\n')).toBeGreaterThanOrEqual(0);
    expect(stdout.indexOf('  local_file.f (local-exec): said\n')).toBeLessThan(stdout.indexOf('local_file.f destroyed'));
  });

  it('runs each in the order written', async () => {
    await madeThenRemoved(fileWith('a.txt', 'one', onDestroy(command('echo 1 >> log.txt')) + onDestroy(command('echo 2 >> log.txt'))));

    await clayIn('apply', '--yes');

    expect(await read('log.txt')).toBe('1\n2\n');
  });

  it('runs on the old object of a replace, reading it through self', async () => {
    const body = onDestroy(command('echo ${self.path} >> log.txt'));
    await write(fileWith('a.txt', 'one', body));
    await clayIn('apply', '--yes');
    await write(fileWith('b.txt', 'one', body));

    await clayIn('apply', '--yes');

    const state = await stateOf();
    expect(await read('log.txt')).toBe('a.txt\n');
    expect(state.resources['local_file.f'].destroyProvisioners).toEqual([{ type: 'local-exec', config: { command: 'echo b.txt >> log.txt' } }]);
  });

  it('runs on the old object of a replace destroyed before its turn', async () => {
    await write(readerReplaced('1'));
    await clayIn('apply', '--yes');
    await write(readerReplaced('2'));

    const stdout = await clayIn('apply', '--yes');

    expect(await read('log.txt')).toBe('b1.txt\n');
    expect(stdout).toContain('  local_file.b (local-exec): Executing: "echo b1.txt >> log.txt"\n');
  });

  it('runs as the last update left it', async () => {
    const body = onDestroy(command('echo ${self.content} >> log.txt'));
    await write(fileWith('a.txt', 'one', body));
    await clayIn('apply', '--yes');
    await madeThenRemoved(fileWith('a.txt', 'two', body));

    await clayIn('apply', '--yes');

    expect(await read('log.txt')).toBe('two\n');
  });

  it('runs as the last apply left it, though that apply changed nothing else, which it reports as a change', async () => {
    await write(fileWith('a.txt', 'one', onDestroy(command('echo old >> log.txt'))));
    await clayIn('apply', '--yes');
    await write(fileWith('a.txt', 'one', onDestroy(command('echo new >> log.txt'))));
    const applied = await clayIn('apply', '--yes');
    await write('');

    await clayIn('apply', '--yes');

    expect(applied).toContain('Apply complete! Resources: 0 added, 1 changed, 0 destroyed.');
    expect(await read('log.txt')).toBe('new\n');
  });

  it('shows a plan that changes nothing but it as an update that says so', async () => {
    await write(fileWith('a.txt', 'one', onDestroy(command('echo old'))));
    await clayIn('apply', '--yes');
    await write(fileWith('a.txt', 'one', onDestroy(command('echo new'))));

    const stdout = stripVTControlCharacters(await clayIn('plan'));

    expect(stdout).toContain('  ~ local_file.f will be updated\n      the provisioners run before it is destroyed will change\n\nPlan: 0 to add, 1 to change, 0 to destroy.');
  });

  it('is no longer kept once the block drops it', async () => {
    await write(fileWith('a.txt', 'one', onDestroy(command('echo gone >> log.txt'))));
    await clayIn('apply', '--yes');
    await madeThenRemoved(fileWith('a.txt', 'one', ''));

    await clayIn('apply', '--yes');

    await expect(read('log.txt')).rejects.toThrow('ENOENT');
  });

  it('keeps the object when it fails, and the next apply runs it again', async () => {
    await madeThenRemoved(fileWith('a.txt', 'one', onDestroy(command('echo tried >> log.txt; test -f go.txt'))));

    const { stderr, code } = await failure('apply', '--yes');

    expect(code).toBe(1);
    expect(stderr).toContain('local_file.f: local-exec failed: the command exited with 1');
    expect(await read('a.txt')).toBe('one');
    const state = await stateOf();
    expect(state.resources['local_file.f'].tainted).toBeUndefined();

    await fs.writeFile(file('go.txt'), '');
    await clayIn('apply', '--yes');

    expect(await read('log.txt')).toBe('tried\ntried\n');
    await expect(read('a.txt')).rejects.toThrow('ENOENT');
  });

  it('goes on past one that fails with on_failure = continue, says so, and destroys the object', async () => {
    await madeThenRemoved(fileWith('a.txt', 'one', onDestroy(`${command('exit 3')}    on_failure = continue\n`) + onDestroy(command('echo 2 >> log.txt'))));

    const stdout = await clayIn('apply', '--yes');

    expect(stdout).toContain('  local_file.f (local-exec): local-exec failed: the command exited with 3, and the apply goes on as on_failure = continue says\n');
    expect(await read('log.txt')).toBe('2\n');
    await expect(read('a.txt')).rejects.toThrow('ENOENT');
  });

  it('leaves a new object tainted when a value only the apply knows is refused, and the next apply makes it again', async () => {
    await write(madeThen('self.id != "" ? "" : "x"'));

    const { stderr } = await failure('apply', '--yes');

    const state = await stateOf();
    expect(stderr).toContain('local-exec "command" must not be empty');
    expect(state.resources['null_resource.n'].tainted).toBe(true);
    await expect(read('log.txt')).rejects.toThrow('ENOENT');

    await write(madeThen('"echo gone"'));
    await clayIn('apply', '--yes');

    expect(await read('log.txt')).toBe('made\n');
  });

  it('keeps none read from the old values when an update meets a value only the apply knows that is refused', async () => {
    await write(readingStdout('one'));
    await clayIn('apply', '--yes');
    await write(readingStdout(String.raw`\"\"`));

    const { stderr } = await failure('apply', '--yes');

    const state = await stateOf();
    expect(stderr).toContain('local-exec "command" must not be empty');
    expect(state.resources['null_resource.n'].destroyProvisioners).toBeUndefined();
  });

  it('does not run on a tainted object', async () => {
    await write(fileWith('a.txt', 'one', `  provisioner "local-exec" {\n${command('exit 3')}  }\n` + onDestroy(command('echo ran >> log.txt'))));
    await failure('apply', '--yes');
    await write('');

    await clayIn('apply', '--yes');

    await expect(read('log.txt')).rejects.toThrow('ENOENT');
    await expect(read('a.txt')).rejects.toThrow('ENOENT');
  });

  it('prints none of what it prints when a value it reads through self is sensitive', async () => {
    const token = 'variable "token" {\n  default   = "s3cr3t-token"\n  sensitive = true\n}\n';
    await write(token + fileWith('a.txt', '${var.token}', onDestroy(command('echo ${self.content}'))));
    await clayIn('apply', '--yes');
    await write(token);

    const stdout = await clayIn('apply', '--yes');

    expect(stdout).toContain('  local_file.f (local-exec): a value given to it is sensitive, so what it prints is not shown\n');
    expect(stdout).not.toContain('s3cr3t-token');
  });

  it('runs on each instance, reading its own count.index and each.key', async () => {
    await madeThenRemoved(
      'resource "null_resource" "c" {\n  count = 2\n' +
        onDestroy(command('echo ${count.index} >> log.txt')) +
        '}\n' +
        'resource "null_resource" "e" {\n  for_each = { k = "v" }\n' +
        onDestroy(command('echo ${each.key} >> log.txt')) +
        '}\n'
    );

    await clayIn('apply', '--yes');

    const log = await read('log.txt');
    expect(log.split('\n').sort()).toEqual(['', '0', '1', 'k']);
  });

  it('is checked by a plan that changes nothing, which would keep it as written', async () => {
    await write(fileWith('a.txt', '', ''));
    await clayIn('apply', '--yes');
    await write(fileWith('a.txt', '', onDestroy('    command = self.content\n')));

    const { stderr } = await failure('plan');

    expect(stderr).toContain('local-exec "command" must not be empty');
  });

  it.each([
    ['a variable', 'variable "v" {\n  default = "x"\n}\n', 'echo ${var.v}', '${var.v}'],
    ['another resource', 'resource "null_resource" "other" {}\n', 'echo ${null_resource.other.id}', '${null_resource.other.id}'],
    ['each.value', '', 'echo ${each.value}', '${each.value}'],
  ])('refuses %s, where it is written', async (_, before, text, source) => {
    await write(`${before}resource "null_resource" "n" {\n  for_each = { k = "v" }\n${onDestroy(command(text))}}\n`);

    const { stderr } = await failure('validate');

    expect(stderr).toContain('a provisioner with when = destroy reads only self, count.index and each.key, as it runs on the object alone');
    expect(stderr).toContain('in resource "null_resource" "n"');
    expect(stderr).toContain(source);
  });
});
