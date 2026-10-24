import { State } from '@clay/contracts';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const clay = path.resolve(__dirname, '../../bin/clay.js');

describe('ignore_changes', () => {
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
  const read = (name: string) => fs.readFile(file(name), 'utf8');

  /** `ignore` is what the argument holds, as written: `[content]` or `all`. */
  const written = async (name: string, content: string, ignore?: string) => {
    const lifecycle = ignore === undefined ? '' : `  lifecycle {\n    ignore_changes = ${ignore}\n  }\n`;
    await fs.writeFile(file('main.clay'), `resource "local_file" "f" {\n  path    = "${file(name)}"\n  content = "${content}"\n${lifecycle}}\n`, 'utf8');
  };

  const triggers = async (pairs: Record<string, string>, ignore?: string) => {
    const lifecycle = ignore === undefined ? '' : `  lifecycle {\n    ignore_changes = ${ignore}\n  }\n`;
    const map = Object.entries(pairs)
      .map(([key, value]) => `${key} = "${value}"`)
      .join(', ');
    await fs.writeFile(file('main.clay'), `resource "null_resource" "n" {\n  triggers = { ${map} }\n${lifecycle}}\n`, 'utf8');
  };

  const held = async (address: string, attribute: string) => {
    const state = JSON.parse(await fs.readFile(file('clay.state.json'), 'utf8')) as State;
    return state.resources[address].attributes[attribute];
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-ignore-'));
    await clayIn('init');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('plans no change for an attribute it names, and an apply leaves the file as it was', async () => {
    await written('a.txt', 'one', '[content]');
    await clayIn('apply', '--yes');
    await written('a.txt', 'two', '[content]');

    expect(await clayIn('plan')).toContain('No changes.');
    await clayIn('apply', '--yes');

    expect(await read('a.txt')).toBe('one');
    expect(await held('local_file.f', 'content')).toBe('one');
  });

  it('plans the change again once the attribute is not named', async () => {
    await written('a.txt', 'one', '[content]');
    await clayIn('apply', '--yes');
    await written('a.txt', 'two');

    expect(await clayIn('plan')).toContain('content: "one" -> "two"');
  });

  it('does not ignore a first apply', async () => {
    await written('a.txt', 'one', '[content]');

    await clayIn('apply', '--yes');

    expect(await read('a.txt')).toBe('one');
  });

  it('plans no replace for an ignored attribute that forces one', async () => {
    await written('a.txt', 'one', '[path]');
    await clayIn('apply', '--yes');
    await written('b.txt', 'one', '[path]');

    expect(await clayIn('plan')).toContain('No changes.');
  });

  it('refuses an ignored attribute its provider refuses, as written', async () => {
    await written('a.txt', 'one', '[path]');
    await clayIn('apply', '--yes');
    await fs.writeFile(file('main.clay'), 'resource "local_file" "f" {\n  path    = ""\n  content = "one"\n  lifecycle {\n    ignore_changes = [path]\n  }\n}\n', 'utf8');

    expect(await refusal('plan')).toContain('local_file "path" must not be empty');
  });

  it('keeps the ignored value when another attribute replaces the resource', async () => {
    await written('a.txt', 'one', '[content]');
    await clayIn('apply', '--yes');
    await written('b.txt', 'two', '[content]');

    const applied = await clayIn('apply', '--yes');

    expect(applied).toContain('Apply complete! Resources: 1 added, 0 changed, 1 destroyed.');
    expect(await read('b.txt')).toBe('one');
  });

  it('ignores every attribute with all', async () => {
    await written('a.txt', 'one', 'all');
    await clayIn('apply', '--yes');
    await written('b.txt', 'two', 'all');

    expect(await clayIn('plan')).toContain('No changes.');
  });

  it('ignores one key of a map and plans the others', async () => {
    await triggers({ a: '1', b: '1' }, '[triggers["a"]]');
    await clayIn('apply', '--yes');
    await triggers({ a: '2', b: '2' }, '[triggers["a"]]');

    const planned = await clayIn('plan');
    await clayIn('apply', '--yes');

    expect(planned).toContain('~ null_resource.n will be updated');
    expect(planned).toContain('"b"');
    expect(await held('null_resource.n', 'triggers')).toEqual({ a: '1', b: '2' });
  });

  it('applies a saved plan the same way', async () => {
    await triggers({ a: '1', b: '1' }, '[triggers["a"]]');
    await clayIn('apply', '--yes');
    await triggers({ a: '2', b: '2' }, '[triggers["a"]]');
    await clayIn('plan', '--out', 'plan.json');

    await clayIn('apply', 'plan.json', '--yes');

    expect(await held('null_resource.n', 'triggers')).toEqual({ a: '1', b: '2' });
  });

  it('still shows what changed outside Clay, and plans nothing for it', async () => {
    await written('a.txt', 'one', '[content]');
    await clayIn('apply', '--yes');
    await fs.writeFile(file('a.txt'), 'by hand', 'utf8');

    const planned = await clayIn('plan');

    expect(planned).toContain('local_file.f was changed outside Clay');
    expect(planned).not.toContain('will be updated');
  });

  it('refuses a name the resource does not have, at the path', async () => {
    await written('a.txt', 'one', '[nope]');

    const error = await refusal('plan');

    expect(error).toContain('ignore_changes names "nope", which local_file does not have');
    expect(error).toContain('on main.clay line 5');
  });
});
