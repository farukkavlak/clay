import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const clay = path.resolve(__dirname, '../../../bin/clay.js');

describe('create_before_destroy on files', () => {
  let dir: string;

  const clayIn = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
    return stripVTControlCharacters(stdout);
  };

  const file = (name: string) => path.join(dir, name);
  const exists = (name: string) =>
    fs.access(file(name)).then(
      () => true,
      () => false
    );

  const written = (name: string, protect = false) =>
    fs.writeFile(
      file('main.clay'),
      `resource "local_file" "f" {\n  path    = "${file(name)}"\n  content = "x"\n  lifecycle {\n    create_before_destroy = true\n${protect ? '    prevent_destroy = true\n' : ''}  }\n}\n`,
      'utf8'
    );

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-first-files-'));
    await clayIn('init');
    await written('a.txt');
    await clayIn('apply', '--yes');
    await written('b.txt');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('says the new object is made first, and counts one add and one destroy', async () => {
    const planned = await clayIn('plan');
    const applied = await clayIn('apply', '--yes');

    expect(planned).toContain('-+ local_file.f will be replaced, the new one created first');
    expect(planned).toContain('Plan: 1 to add, 0 to change, 1 to destroy.');
    expect(applied).toContain('replaced, the new one created first');
    expect(applied).toContain('  - local_file.f (deposed object) destroyed');
    expect(applied).toContain('Apply complete! Resources: 1 added, 0 changed, 1 destroyed.');
    expect(await exists('a.txt')).toBe(false);
    expect(await exists('b.txt')).toBe(true);
  });

  it('counts the destroy once where a deposed object is already planned for the address', async () => {
    const state = JSON.parse(await fs.readFile(file('clay.state.json'), 'utf8')) as { deposed?: Record<string, unknown[]> };
    await fs.writeFile(file('old.txt'), 'old', 'utf8');
    state.deposed = { 'local_file.f': [{ attributes: { path: file('old.txt'), content: 'old', id: file('old.txt') } }] };
    await fs.writeFile(file('clay.state.json'), JSON.stringify(state, null, 2), 'utf8');

    const planned = await clayIn('plan');
    const applied = await clayIn('apply', '--yes');

    expect(planned).toContain('Plan: 1 to add, 0 to change, 1 to destroy.');
    expect(applied).toContain('Apply complete! Resources: 1 added, 0 changed, 1 destroyed.');
    expect(await exists('old.txt')).toBe(false);
    expect(await exists('a.txt')).toBe(false);
  });

  it('applies from a saved plan the same way', async () => {
    await clayIn('plan', '--out', 'plan.json');

    await clayIn('apply', 'plan.json', '--yes');

    expect(await exists('a.txt')).toBe(false);
    expect(await exists('b.txt')).toBe(true);
  });

  it('is still refused by prevent_destroy', async () => {
    await written('a.txt', true);
    await clayIn('apply', '--yes');
    await written('b.txt', true);

    await expect(clayIn('plan')).rejects.toThrow(/cannot be replaced/);
  });
});
