import { State } from '@clay/contracts';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const clay = path.resolve(__dirname, '../../bin/clay.js');

const call = (count: number) => `module "m" {\n  source = "./m"\n  count  = ${count}\n}\n`;

describe('prevent_destroy', () => {
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

  /** `protect` is what the block says: left out, true or false. */
  const written = async (name: string, protect?: boolean, count?: number) => {
    const lifecycle = protect === undefined ? '' : `  lifecycle {\n    prevent_destroy = ${protect}\n  }\n`;
    const repeat = count === undefined ? '' : `  count   = ${count}\n`;
    const config = `resource "local_file" "db" {\n  path    = "${file(name)}"\n  content = "x"\n${repeat}${lifecycle}}\n`;
    await fs.writeFile(file('main.clay'), config, 'utf8');
  };

  const held = async () => {
    const state = JSON.parse(await fs.readFile(file('clay.state.json'), 'utf8')) as State;
    return Object.fromEntries(Object.entries(state.resources).map(([address, resource]) => [address, resource.preventDestroy]));
  };

  const exists = (name: string) =>
    fs.access(file(name)).then(
      () => true,
      () => false
    );

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-protect-'));
    await clayIn('init');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is remembered in state by the apply', async () => {
    await written('a.txt', true);

    await clayIn('apply', '--yes');

    expect(await held()).toEqual({ 'local_file.db': true });
  });

  it.each([undefined, false])('is not held for a block that says %s', async (protect) => {
    await written('a.txt', protect);

    await clayIn('apply', '--yes');

    expect(await held()).toEqual({ 'local_file.db': undefined });
  });

  it('refuses a plan that replaces the resource, at the block', async () => {
    await written('a.txt', true);
    await clayIn('apply', '--yes');
    await written('b.txt', true);

    const error = await refusal('plan');

    expect(error).toContain('local_file.db cannot be replaced: it has prevent_destroy = true');
    expect(error).toContain('on main.clay line 1');
    expect(await exists('a.txt')).toBe(true);
  });

  it('refuses an apply that would replace it, before anything changes', async () => {
    await written('a.txt', true);
    await clayIn('apply', '--yes');
    await written('b.txt', true);

    await refusal('apply', '--yes');

    expect(await exists('a.txt')).toBe(true);
    expect(await exists('b.txt')).toBe(false);
  });

  it('refuses a plan that deletes it with its block gone, naming the state as the reason', async () => {
    await written('a.txt', true);
    await clayIn('apply', '--yes');
    await fs.writeFile(file('main.clay'), '', 'utf8');

    const error = await refusal('plan');

    expect(error).toContain('local_file.db cannot be deleted: it was applied with prevent_destroy = true');
    expect(error).toContain('set prevent_destroy = false, apply, then delete it');
    expect(await exists('a.txt')).toBe(true);
  });

  it('refuses a plan that deletes an instance count drops', async () => {
    await written('db-${count.index}.txt', true, 2);
    await clayIn('apply', '--yes');
    await written('db-${count.index}.txt', true, 1);

    const error = await refusal('plan');

    expect(error).toContain('local_file.db[1] cannot be deleted');
  });

  it('lets a resource without it be replaced and deleted', async () => {
    await written('a.txt');
    await clayIn('apply', '--yes');
    await written('b.txt');
    await clayIn('apply', '--yes');
    await fs.writeFile(file('main.clay'), '', 'utf8');

    await clayIn('apply', '--yes');

    expect(await exists('a.txt')).toBe(false);
    expect(await exists('b.txt')).toBe(false);
  });

  it('goes by the block where it is still written, so false allows a replace', async () => {
    await written('a.txt', true);
    await clayIn('apply', '--yes');
    await written('b.txt', false);

    await clayIn('apply', '--yes');

    expect(await exists('a.txt')).toBe(false);
    expect(await exists('b.txt')).toBe(true);
    expect(await held()).toEqual({ 'local_file.db': undefined });
  });

  it('reaches state through a saved plan', async () => {
    await written('a.txt', true);
    await clayIn('plan', '--out', 'plan.json');

    await clayIn('apply', 'plan.json', '--yes');

    expect(await held()).toEqual({ 'local_file.db': true });
  });

  it('keeps a resource in a module called with count from being deleted when the call drops it', async () => {
    await fs.mkdir(file('m'));
    await fs.writeFile(file('m/main.clay'), `resource "null_resource" "n" {\n  lifecycle {\n    prevent_destroy = true\n  }\n}\n`, 'utf8');
    await fs.writeFile(file('main.clay'), call(2), 'utf8');
    await clayIn('apply', '--yes');
    await fs.writeFile(file('main.clay'), call(1), 'utf8');

    expect(await refusal('plan')).toContain('module.m[1].null_resource.n cannot be deleted');
  });

  describe('taking it off, then deleting', () => {
    it('shows the change of the flag alone as an update, and an apply writes it', async () => {
      await written('a.txt', true);
      await clayIn('apply', '--yes');
      await written('a.txt', false);

      const planned = await clayIn('plan');
      const applied = await clayIn('apply', '--yes');

      expect(planned).toContain('  ~ local_file.db will be updated\n      prevent_destroy: will no longer be set\n\nPlan: 0 to add, 1 to change, 0 to destroy.');
      expect(applied).toContain('Apply complete! Resources: 0 added, 1 changed, 0 destroyed.');
      expect(await held()).toEqual({ 'local_file.db': undefined });
      expect(await clayIn('plan')).toContain('No changes.');
    });

    it('then lets the block go', async () => {
      await written('a.txt', true);
      await clayIn('apply', '--yes');
      await written('a.txt', false);
      await clayIn('apply', '--yes');
      await fs.writeFile(file('main.clay'), '', 'utf8');

      await clayIn('apply', '--yes');

      expect(await exists('a.txt')).toBe(false);
    });

    it('shows a flag put on as an update too', async () => {
      await written('a.txt');
      await clayIn('apply', '--yes');
      await written('a.txt', true);

      const planned = await clayIn('plan');
      await clayIn('apply', '--yes');

      expect(planned).toContain('prevent_destroy: will be set');
      expect(await held()).toEqual({ 'local_file.db': true });
    });
  });
});
