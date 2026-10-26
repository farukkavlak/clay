import { DeposedObject, State } from '@clay/contracts';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clayOutput } from '../helpers';

describe('deposed objects', () => {
  let dir: string;

  const clayIn = (...args: string[]) => clayOutput(dir, ...args);

  const refusal = async (...args: string[]): Promise<string> => {
    try {
      await clayIn(...args);
    } catch (error) {
      const { stdout, stderr } = error as { stdout: string; stderr: string };
      return stripVTControlCharacters(stdout + stderr);
    }

    throw new Error('Expected the command to be refused');
  };

  const file = (name: string) => path.join(dir, name);
  const exists = (name: string) =>
    fs.access(file(name)).then(
      () => true,
      () => false
    );

  const config = (protect = false) =>
    `resource "local_file" "db" {\n  path    = "${file('db.txt')}"\n  content = "x"\n${protect ? '  lifecycle {\n    prevent_destroy = true\n  }\n' : ''}}\n`;

  const readState = async () => JSON.parse(await fs.readFile(file('clay.state.json'), 'utf8')) as State;
  const deposedAt = async (address: string) => {
    const state = await readState();
    return state.deposed?.[address];
  };
  const deposedInState = async () => {
    const state = await readState();
    return state.deposed;
  };

  /** What an interrupted run leaves: a second object the state still holds besides the current one. */
  const depose = async (address: string, object: DeposedObject) => {
    const state = await readState();
    state.deposed = { ...state.deposed, [address]: [...(state.deposed?.[address] ?? []), object] };
    await fs.writeFile(file('clay.state.json'), JSON.stringify(state, null, 2), 'utf8');
  };

  const oldFile = async (name = 'old.txt'): Promise<DeposedObject> => {
    await fs.writeFile(file(name), 'old', 'utf8');
    return { attributes: { path: file(name), content: 'old', id: file(name) } };
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-deposed-'));
    await clayIn('init');
    await fs.writeFile(file('main.clay'), config(), 'utf8');
    await clayIn('apply', '--yes');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('plans to destroy it, beside a resource that stays', async () => {
    await depose('local_file.db', await oldFile());

    const planned = await clayIn('plan');

    expect(planned).toContain('  - local_file.db (deposed object) will be destroyed');
    expect(planned).toContain('Plan: 0 to add, 0 to change, 1 to destroy.');
  });

  it('destroys it in the apply and leaves the current object alone', async () => {
    await depose('local_file.db', await oldFile());

    const applied = await clayIn('apply', '--yes');

    expect(applied).toContain('  - local_file.db (deposed object) destroyed');
    expect(applied).toContain('Apply complete! Resources: 0 added, 0 changed, 1 destroyed.');
    expect(await exists('old.txt')).toBe(false);
    expect(await exists('db.txt')).toBe(true);
    expect(await deposedInState()).toBeUndefined();
    expect(await clayIn('plan')).toContain('No changes.');
  });

  it('destroys every one it holds for the address', async () => {
    await depose('local_file.db', await oldFile('one.txt'));
    await depose('local_file.db', await oldFile('two.txt'));

    await clayIn('apply', '--yes');

    expect(await exists('one.txt')).toBe(false);
    expect(await exists('two.txt')).toBe(false);
  });

  it('destroys it with the resource when the configuration drops both', async () => {
    await depose('local_file.db', await oldFile());
    await fs.writeFile(file('main.clay'), '', 'utf8');

    const planned = await clayIn('plan');
    await clayIn('apply', '--yes');

    expect(planned).toContain('Plan: 0 to add, 0 to change, 2 to destroy.');
    expect(await exists('db.txt')).toBe(false);
    expect(await exists('old.txt')).toBe(false);
    expect(await deposedInState()).toBeUndefined();
  });

  it('is not held back by prevent_destroy on the resource', async () => {
    await fs.writeFile(file('main.clay'), config(true), 'utf8');
    await clayIn('apply', '--yes');
    await depose('local_file.db', await oldFile());

    await clayIn('apply', '--yes');

    expect(await exists('old.txt')).toBe(false);
  });

  it('applies from a saved plan', async () => {
    await depose('local_file.db', await oldFile());
    await clayIn('plan', '--out', 'plan.json');

    await clayIn('apply', 'plan.json', '--yes');

    expect(await exists('old.txt')).toBe(false);
  });

  it('stays in state when the provider cannot destroy it, and the next run tries again', async () => {
    await fs.mkdir(file('stuck'));
    await depose('local_file.db', { attributes: { path: file('stuck'), content: 'old', id: file('stuck') } });

    const error = await refusal('apply', '--yes');

    expect(error).toContain('local_file.db');
    expect(await deposedAt('local_file.db')).toHaveLength(1);
    expect(await clayIn('plan')).toContain('local_file.db (deposed object) will be destroyed');
  });

  it('keeps the ones it did not reach when a later one fails', async () => {
    await fs.mkdir(file('stuck'));
    await depose('local_file.db', await oldFile('first.txt'));
    await depose('local_file.db', { attributes: { path: file('stuck'), content: 'old', id: file('stuck') } });
    await depose('local_file.db', await oldFile('third.txt'));

    await refusal('apply', '--yes');

    expect(await exists('first.txt')).toBe(false);
    expect(await deposedAt('local_file.db')).toHaveLength(2);
  });

  it('counts a resource deleted outside Clay as forgotten, though its deposed object is destroyed', async () => {
    await depose('local_file.db', await oldFile());
    await fs.writeFile(file('main.clay'), '', 'utf8');
    await fs.rm(file('db.txt'));

    const applied = await clayIn('apply', '--yes');

    expect(applied).toContain('Apply complete! Resources: 0 added, 0 changed, 1 destroyed, 1 forgotten.');
    expect(await exists('old.txt')).toBe(false);
  });

  it('refuses a saved plan when the state no longer holds the object it destroys', async () => {
    await depose('local_file.db', await oldFile());
    await clayIn('plan', '--out', 'plan.json');
    const state = await readState();
    delete state.deposed;
    await fs.writeFile(file('clay.state.json'), JSON.stringify(state, null, 2), 'utf8');

    const error = await refusal('apply', 'plan.json', '--yes');

    expect(error).toContain('Apply failed: local_file.db: state holds no deposed object');
    expect(await exists('old.txt')).toBe(true);
  });

  describe('state commands', () => {
    it('shows a resource beside deposed objects held under another address', async () => {
      await depose('local_file.other', await oldFile());

      const shown = await clayIn('state', 'show', 'local_file.db');

      expect(shown).toContain('# local_file.db:');
      expect(shown).not.toContain(' deposed:');
    });

    it('lists, shows and removes an address that holds only deposed objects', async () => {
      await depose('local_file.gone', await oldFile());

      expect(await clayIn('state', 'list')).toContain('local_file.gone (deposed)');
      expect(await clayIn('state', 'show', 'local_file.gone')).toContain('# local_file.gone deposed:');

      await clayIn('state', 'rm', 'local_file.gone');

      expect((await deposedInState()) ?? {}).not.toHaveProperty('local_file.gone');
    });

    it('lists a state that holds only deposed objects', async () => {
      await depose('local_file.gone', await oldFile());
      await clayIn('state', 'rm', 'local_file.db');

      expect(await clayIn('state', 'list')).toBe('local_file.gone (deposed)\n');
    });

    it('lists and shows it', async () => {
      await depose('local_file.db', await oldFile());

      expect(await clayIn('state', 'list')).toContain('local_file.db (deposed)');
      expect(await clayIn('state', 'show', 'local_file.db')).toContain('# local_file.db deposed:');
    });

    it('moves it with the resource', async () => {
      await depose('local_file.db', await oldFile());

      await clayIn('state', 'mv', 'local_file.db', 'local_file.moved');

      expect(Object.keys((await deposedInState()) ?? {})).toEqual(['local_file.moved']);
    });

    it('removes it with the resource', async () => {
      await depose('local_file.db', await oldFile());

      await clayIn('state', 'rm', 'local_file.db');

      expect(await deposedInState()).toBeUndefined();
    });
  });
});
