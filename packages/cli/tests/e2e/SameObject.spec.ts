import { State } from '@clay/contracts';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The tests compile to CommonJS, which has no import.meta.dirname.
// eslint-disable-next-line unicorn/prefer-module
const clay = path.resolve(__dirname, '../../bin/clay.js');

const fileBlock = (name: string, at: string, cbd = false) =>
  `resource "local_file" "${name}" {\n  path    = "${at}"\n  content = "x"\n${cbd ? '  lifecycle {\n    create_before_destroy = true\n  }\n' : ''}}\n`;

// A path the plan cannot know: the command prints it at apply.
const late = 'resource "command_exec" "e" {\n  command = "printf f.txt"\n}\n';
const lateFile = (name: string) => `resource "local_file" "${name}" {\n  path    = command_exec.e.stdout\n  content = "${name}"\n}\n`;
const reader = (of: string) => `resource "null_resource" "u" {\n  triggers = { x = local_file.${of}.id }\n}\n`;

/** Whether the directory finds a file by a name in another case. */
async function ignoresCase(dir: string): Promise<boolean> {
  await fs.writeFile(path.join(dir, 'probe'), '', 'utf8');
  return fs.access(path.join(dir, 'PROBE')).then(
    () => true,
    () => false
  );
}

describe('two objects that are one file', () => {
  let dir: string;

  const clayIn = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
    return stripVTControlCharacters(stdout);
  };

  const refusal = async (...args: string[]): Promise<string> => {
    try {
      await clayIn(...args);
    } catch (error) {
      return stripVTControlCharacters((error as { stderr: string }).stderr);
    }

    throw new Error('Expected the command to be refused');
  };

  const file = (name: string) => path.join(dir, name);
  const write = (...blocks: string[]) => fs.writeFile(file('main.clay'), blocks.join('\n'), 'utf8');
  const addresses = async () => Object.keys((JSON.parse(await fs.readFile(file('clay.state.json'), 'utf8')) as State).resources);
  const exists = (name: string) =>
    fs.access(file(name)).then(
      () => true,
      () => false
    );

  beforeEach(async () => {
    // The real path, so it matches what the CLI resolves on a system whose temp directory is a link.
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-same-')));
    await clayIn('init');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses a rename, which would destroy the file the new name makes, and says how to move it', async () => {
    await write(fileBlock('c', 'f.txt'));
    await clayIn('apply', '--yes');
    await write(fileBlock('d', 'f.txt'));

    const refused = await refusal('apply', '--yes', '--parallelism', '1');

    expect(refused).toContain(`local_file.d is the file ${file('f.txt')}, which local_file.c holds and this plan destroys`);
    expect(refused).toContain('clay state mv local_file.c local_file.d');
    expect(await exists('f.txt')).toBe(true);
    expect(await addresses()).toEqual(['local_file.c']);
  });

  it('applies the rename once the state is moved', async () => {
    await write(fileBlock('c', 'f.txt'));
    await clayIn('apply', '--yes');
    await write(fileBlock('d', 'f.txt'));

    await clayIn('state', 'mv', 'local_file.c', 'local_file.d');
    const applied = await clayIn('apply', '--yes');

    expect(applied).toContain('No changes.');
    expect(await exists('f.txt')).toBe(true);
  });

  it('refuses two blocks that write one file', async () => {
    await write(fileBlock('a', 'f.txt'), fileBlock('b', './f.txt'));

    const refused = await refusal('plan');

    expect(refused).toContain(`local_file.b and local_file.a are both the file ${file('f.txt')}`);
    expect(await exists('f.txt')).toBe(false);
  });

  it('refuses a new block that writes the file one that stays holds', async () => {
    await write(fileBlock('a', 'f.txt'));
    await clayIn('apply', '--yes');
    await write(fileBlock('a', 'f.txt'), fileBlock('b', file('f.txt')));

    expect(await refusal('plan')).toContain(`local_file.b and local_file.a are both the file ${file('f.txt')}`);
  });

  it('refuses a replace whose old file a new block writes, with no move to suggest', async () => {
    await write(fileBlock('a', 'x.txt'));
    await clayIn('apply', '--yes');
    await write(fileBlock('a', 'y.txt'), fileBlock('b', 'x.txt'));

    const refused = await refusal('plan');

    expect(refused).toContain(`local_file.b is the file ${file('x.txt')}, which local_file.a holds and this plan destroys`);
    expect(refused).not.toContain('clay state mv');
  });

  it('refuses a replace onto the file a deleted block holds, with no move to suggest', async () => {
    await write(fileBlock('a', 'y.txt'), fileBlock('c', 'x.txt'));
    await clayIn('apply', '--yes');
    await write(fileBlock('a', 'x.txt'));

    const refused = await refusal('plan');

    expect(refused).toContain(`local_file.a is the file ${file('x.txt')}, which local_file.c holds and this plan destroys`);
    expect(refused).not.toContain('clay state mv');
  });

  // An update writes the file it already is; a replace would unlink it and write another.
  it.each([
    ['', false],
    [' with create_before_destroy', true],
  ])('updates a path spelled another way for the same file%s, keeping the file', async (_, cbd) => {
    await write(fileBlock('a', 'a.txt', cbd));
    await clayIn('apply', '--yes');
    const { ino } = await fs.stat(file('a.txt'));
    await write(fileBlock('a', './a.txt', cbd));

    const applied = await clayIn('apply', '--yes');

    expect(applied).toContain('~ local_file.a updated');
    expect(applied).toContain('Resources: 0 added, 1 changed, 0 destroyed.');
    expect(await fs.stat(file('a.txt'))).toMatchObject({ ino });
  });

  it('refuses a block that writes the file a deposed object holds', async () => {
    await write(fileBlock('a', 'a.txt'));
    await clayIn('apply', '--yes');
    const state = JSON.parse(await fs.readFile(file('clay.state.json'), 'utf8')) as State;
    state.deposed = { 'local_file.old': [{ attributes: { path: 'b.txt', content: 'x', id: file('b.txt') } }] };
    await fs.writeFile(file('clay.state.json'), JSON.stringify(state, null, 2), 'utf8');
    await write(fileBlock('a', 'a.txt'), fileBlock('b', 'b.txt'));

    expect(await refusal('plan')).toContain(`local_file.b is the file ${file('b.txt')}, which a deposed object of local_file.old holds and this plan destroys`);
  });

  describe('where the path is known only at apply', () => {
    it('refuses the second of two blocks that write one file before it writes', async () => {
      await write(late, lateFile('a'), lateFile('b'));

      const refused = await refusal('apply', '--yes', '--parallelism', '1');

      expect(refused).toContain(`local_file.b and local_file.a are both the file ${file('f.txt')}`);
      expect(await fs.readFile(file('f.txt'), 'utf8')).toBe('a');
      expect(await addresses()).toEqual(['command_exec.e', 'local_file.a']);
    });

    // Both are made in one layer, so neither is in the state when the other is checked.
    it('refuses one of two blocks that write one file at the same time', async () => {
      await write(late, lateFile('a'), lateFile('b'));

      const refused = await refusal('apply', '--yes');

      expect(refused).toMatch(/local_file\.[ab] and local_file\.[ab] are both the file/);
      const held = await addresses();
      const made = held.filter((address) => address.startsWith('local_file'));
      expect(made).toHaveLength(1);
      expect(await fs.readFile(file('f.txt'), 'utf8')).toBe(made[0].slice('local_file.'.length));
    });

    // The delete of c waits for u to stop reading it, and u's update waits for d, so d is made while c still holds the file.
    it('refuses a create onto the file of an object still to be destroyed', async () => {
      await write(fileBlock('c', 'f.txt'), reader('c'));
      await clayIn('apply', '--yes');
      await write(late, lateFile('d'), reader('d'));

      const refused = await refusal('apply', '--yes');

      expect(refused).toContain(`local_file.d is the file ${file('f.txt')}, which local_file.c holds and this plan destroys`);
      expect(refused).toContain('clay state mv local_file.c local_file.d');
      expect(await fs.readFile(file('f.txt'), 'utf8')).toBe('x');
      expect(await addresses()).toContain('local_file.c');
    });

    it('creates onto the file of an object already destroyed', async () => {
      await write(fileBlock('c', 'f.txt'));
      await clayIn('apply', '--yes');
      await write(late, lateFile('d'));

      expect(await clayIn('apply', '--yes')).toContain('Resources: 2 added, 0 changed, 1 destroyed.');
      expect(await fs.readFile(file('f.txt'), 'utf8')).toBe('d');
    });

    // c's object is left deposed, and u still reads it, so its destroy waits for u's update, which waits for d.
    it('refuses a create onto the file of a deposed object still to be destroyed', async () => {
      await write(fileBlock('c', 'f.txt'), reader('c'));
      await clayIn('apply', '--yes');
      const state = JSON.parse(await fs.readFile(file('clay.state.json'), 'utf8')) as State;
      state.deposed = { 'local_file.c': [{ attributes: state.resources['local_file.c'].attributes }] };
      delete state.resources['local_file.c'];
      await fs.writeFile(file('clay.state.json'), JSON.stringify(state, null, 2), 'utf8');
      await write(late, lateFile('d'), reader('d'));

      const refused = await refusal('apply', '--yes');

      expect(refused).toContain(`local_file.d is the file ${file('f.txt')}, which a deposed object of local_file.c holds and this plan destroys`);
      expect(await fs.readFile(file('f.txt'), 'utf8')).toBe('x');
    });

    it('refuses a create_before_destroy replace whose new file, known only at apply, is its old one', async () => {
      await write(fileBlock('a', 'f.txt', true));
      await clayIn('apply', '--yes');
      await write(late, fileBlock('a', 'f.txt', true).replace('"f.txt"', 'command_exec.e.stdout'));

      const refused = await refusal('apply', '--yes');

      expect(refused).toContain(`local_file.a makes its new object before it destroys the old one, but both are the file ${file('f.txt')}`);
      expect(await fs.readFile(file('f.txt'), 'utf8')).toBe('x');
    });
  });

  describe('as the disk names the file', () => {
    it('refuses two blocks that write one file through a link', async () => {
      await fs.mkdir(file('dir'));
      await fs.symlink(file('dir'), file('link'));
      await write(fileBlock('a', 'dir/f.txt'), fileBlock('b', 'link/f.txt'));

      expect(await refusal('plan')).toContain(`local_file.b and local_file.a are both the file ${file('dir/f.txt')}`);
    });

    it('renames a block from a link to the file it points to, which are two files to a delete', async () => {
      await fs.writeFile(file('real.txt'), 'y', 'utf8');
      await fs.symlink(file('real.txt'), file('l.txt'));
      await write(fileBlock('c', 'l.txt'));
      await clayIn('apply', '--yes');
      await write(fileBlock('d', 'real.txt'));

      expect(await clayIn('plan')).toContain('Plan: 1 to add, 0 to change, 1 to destroy.');
    });

    it('refuses a path the disk cannot follow at its block', async () => {
      await fs.symlink('loop', file('loop'));
      await write(fileBlock('a', 'loop/f.txt'));

      const refused = await refusal('plan');

      expect(refused).toContain('ELOOP');
      expect(refused).toContain('resource "local_file" "a"');
    });

    it('refuses a new block that writes a file that exists in another case', async (context) => {
      if (!(await ignoresCase(dir))) context.skip();
      await write(fileBlock('a', 'a.txt'));
      await clayIn('apply', '--yes');
      await write(fileBlock('a', 'a.txt'), fileBlock('b', 'A.txt'));

      expect(await refusal('plan')).toContain(`local_file.b and local_file.a are both the file ${file('a.txt')}`);
    });

    it('updates a create_before_destroy file whose path changes case, keeping the file', async (context) => {
      if (!(await ignoresCase(dir))) context.skip();
      await write(fileBlock('a', 'a.txt', true));
      await clayIn('apply', '--yes');
      await write(fileBlock('a', 'A.txt', true));

      const applied = await clayIn('apply', '--yes');

      expect(applied).toContain('~ local_file.a updated');
      expect(await fs.readFile(file('a.txt'), 'utf8')).toBe('x');
    });
  });
});
