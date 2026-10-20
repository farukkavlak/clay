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

  it('refuses a create_before_destroy replace whose new object is its old one', async () => {
    await write(fileBlock('a', 'a.txt', true));
    await clayIn('apply', '--yes');
    await write(fileBlock('a', './a.txt', true));

    const refused = await refusal('apply', '--yes');

    expect(refused).toContain(`local_file.a makes its new object before it destroys the old one, but both are the file ${file('a.txt')}`);
    expect(await exists('a.txt')).toBe(true);
  });

  it('replaces a resource whose new object is its old one, since the old one goes first', async () => {
    await write(fileBlock('a', 'a.txt'));
    await clayIn('apply', '--yes');
    await write(fileBlock('a', './a.txt'));

    expect(await clayIn('apply', '--yes')).toContain('-+ local_file.a replaced');
    expect(await exists('a.txt')).toBe(true);
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
});
