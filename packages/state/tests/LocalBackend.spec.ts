import { emptyState } from '@clay/contracts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalBackend } from '../src/backends/LocalBackend';
import { emptySeen } from './emptySeen';

describe('LocalBackend', () => {
  let dir: string;

  /** A state file, empty, as a listing finds it. */
  const made = async (folder: string, file = 'clay.state.json') => {
    await fs.mkdir(path.join(dir, folder), { recursive: true });
    await fs.writeFile(path.join(dir, folder, file), '', 'utf8');
  };

  /** The folder of workspace `dev`. */
  const devFolder = () => path.join(dir, 'clay.workspaces', 'dev');
  /** Workspace `dev` with a state, a backup, a journal and a held lock. */
  const writtenDev = async () => {
    const backend = new LocalBackend(dir).workspace('dev');
    await backend.prepare();
    await backend.write({ ...emptyState(), lineage: 'dev' });
    await backend.append('line\n');
    await fs.writeFile(`${backend.location}.bak`, 'before', 'utf8');
    await fs.writeFile(`${backend.location}.lock`, 'held', 'utf8');
    return backend;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-local-backend-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is located at its state file', () => {
    expect(new LocalBackend(dir, 'named.json').location).toBe(path.join(dir, 'named.json'));
  });

  it('does not exist before a state is written', async () => {
    await expect(new LocalBackend(dir).exists()).resolves.toBe(false);
  });

  it('exists once a state is written', async () => {
    const backend = new LocalBackend(dir);
    await backend.write(emptyState());

    await expect(backend.exists()).resolves.toBe(true);
  });

  it('tells a file it cannot reach from a missing one', async () => {
    await fs.symlink('clay.state.json', path.join(dir, 'clay.state.json'));

    await expect(new LocalBackend(dir).exists()).rejects.toThrow('ELOOP');
  });

  describe('a named workspace', () => {
    const lockInfo = { id: 'run', operation: 'plan', who: 'me', host: 'here', pid: 1, created: 'now' };

    it('keeps its state in a folder of its own beside the default state', () => {
      expect(new LocalBackend(dir).workspace('dev').location).toBe(path.join(dir, 'clay.workspaces', 'dev', 'clay.state.json'));
    });

    it('takes the folder and file name of a path the block gives', () => {
      expect(new LocalBackend(dir, 'states/app.json').workspace('dev').location).toBe(path.join(dir, 'states', 'clay.workspaces', 'dev', 'app.json'));
    });

    it('is the default state where the workspace is "default"', () => {
      expect(new LocalBackend(dir, 'app.json').workspace('default').location).toBe(path.join(dir, 'app.json'));
    });

    it('is found from the default state whichever workspace is asked', () => {
      expect(new LocalBackend(dir).workspace('dev').workspace('test').location).toBe(path.join(dir, 'clay.workspaces', 'test', 'clay.state.json'));
    });

    it('is the backend init remembers, wherever the state of the workspace is', () => {
      expect(new LocalBackend(dir, 'app.json').workspace('dev').choice).toEqual({ type: 'local', where: 'app.json', settings: { path: 'app.json' } });
    });

    it('does not exist while only the default state does', async () => {
      await new LocalBackend(dir).write(emptyState());

      await expect(new LocalBackend(dir).workspace('dev').exists()).resolves.toBe(false);
    });

    it('has a lock of its own', async () => {
      await fs.mkdir(path.join(dir, 'clay.workspaces', 'dev'), { recursive: true });
      await new LocalBackend(dir).lock(lockInfo);

      await new LocalBackend(dir).workspace('dev').lock(lockInfo);
      await expect(fs.readdir(path.join(dir, 'clay.workspaces', 'dev'))).resolves.toEqual(['clay.state.json.lock']);
    });

    it('writes and reads its own state', async () => {
      await fs.mkdir(path.join(dir, 'clay.workspaces', 'dev'), { recursive: true });
      const backend = new LocalBackend(dir).workspace('dev');
      await backend.write({ ...emptyState(), serial: 4, lineage: 'dev' });

      await expect(backend.read()).resolves.toMatchObject({ serial: 4 });
      await expect(new LocalBackend(dir).exists()).resolves.toBe(false);
    });

    it('keeps its backup and journal beside its state', async () => {
      await fs.mkdir(path.join(dir, 'clay.workspaces', 'dev'), { recursive: true });
      const backend = new LocalBackend(dir).workspace('dev');
      await backend.write({ ...emptyState(), lineage: 'dev' });
      await backend.lock(lockInfo);
      await backend.write({ ...emptyState(), serial: 1, lineage: 'dev' });
      await backend.append('line\n');

      await expect(fs.readdir(path.join(dir, 'clay.workspaces', 'dev'))).resolves.toEqual([
        'clay.state.json',
        'clay.state.json.bak',
        'clay.state.json.journal',
        'clay.state.json.lock',
      ]);
    });

    it('has its folder made by prepare, so its state can be written', async () => {
      const backend = new LocalBackend(dir).workspace('dev');
      await backend.prepare();

      await expect(backend.writeIfAbsent({ ...emptyState(), lineage: 'dev' })).resolves.toBe(true);
    });

    it('is prepared again with nothing changed', async () => {
      const backend = new LocalBackend(dir).workspace('dev');
      await backend.prepare();
      await backend.write({ ...emptyState(), lineage: 'dev' });
      await backend.prepare();

      await expect(fs.readdir(path.join(dir, 'clay.workspaces', 'dev'))).resolves.toEqual(['clay.state.json']);
    });

    it('makes no folder the default state does not have', async () => {
      await new LocalBackend(dir, 'kept/app.json').prepare();

      await expect(fs.readdir(dir)).resolves.toEqual([]);
    });
  });

  describe('a named workspace removed', () => {
    it('loses its state, backup and journal, and keeps the lock it is removed under', async () => {
      const backend = await writtenDev();
      await expect(fs.readdir(devFolder())).resolves.toEqual(['clay.state.json', 'clay.state.json.bak', 'clay.state.json.journal', 'clay.state.json.lock']);

      await backend.remove();

      await expect(fs.readdir(devFolder())).resolves.toEqual(['clay.state.json.lock']);
    });

    it('has its folders pruned once the lock is released', async () => {
      const backend = await writtenDev();
      await backend.remove();
      await fs.rm(`${backend.location}.lock`);

      await backend.prune();

      await expect(fs.readdir(dir)).resolves.toEqual([]);
    });

    it('leaves its folders to what is still in them', async () => {
      const backend = await writtenDev();
      await fs.mkdir(path.join(dir, 'clay.workspaces', 'test'));
      await backend.remove();

      await backend.prune();

      await expect(fs.readdir(devFolder())).resolves.toEqual(['clay.state.json.lock']);
      await fs.rm(`${backend.location}.lock`);
      await backend.prune();
      await expect(fs.readdir(path.join(dir, 'clay.workspaces'))).resolves.toEqual(['test']);
    });

    it('is never the default state, whose folder is not pruned', async () => {
      const backend = new LocalBackend(dir, 'kept/app.json');
      await fs.mkdir(path.join(dir, 'kept'));
      await backend.write(emptyState());

      await expect(backend.remove()).rejects.toThrow('The state of the default workspace is not removed');
      await expect(backend.exists()).resolves.toBe(true);
      await fs.rm(path.join(dir, 'kept', 'app.json'));
      await backend.prune();
      await expect(fs.readdir(dir)).resolves.toEqual(['kept']);
    });
  });

  describe('its workspaces', () => {
    it('are the default one alone where none is made', async () => {
      await expect(new LocalBackend(dir).listWorkspaces()).resolves.toEqual(['default']);
    });

    it('are the default one and each named one with a state, in order of name', async () => {
      await made('clay.workspaces/test');
      await made('clay.workspaces/dev');

      await expect(new LocalBackend(dir).listWorkspaces()).resolves.toEqual(['default', 'dev', 'test']);
    });

    it('are the same whichever workspace is asked', async () => {
      await made('clay.workspaces/dev');

      await expect(new LocalBackend(dir).workspace('dev').listWorkspaces()).resolves.toEqual(['default', 'dev']);
    });

    it('leave out a folder with no state, or a state of another file name', async () => {
      await fs.mkdir(path.join(dir, 'clay.workspaces', 'empty'), { recursive: true });
      await made('clay.workspaces/other', 'other.json');

      await expect(new LocalBackend(dir).listWorkspaces()).resolves.toEqual(['default']);
    });

    it('leave out what no workspace can be named, and a file in place of a folder', async () => {
      await made('clay.workspaces/Dev');
      await made('clay.workspaces/default');
      await made('.');
      await fs.writeFile(path.join(dir, 'clay.workspaces', 'file'), '', 'utf8');

      await expect(new LocalBackend(dir).listWorkspaces()).resolves.toEqual(['default']);
    });

    it('are found beside a state a path setting places', async () => {
      await made('kept/clay.workspaces/dev', 'app.json');
      await made('clay.workspaces/other', 'app.json');

      await expect(new LocalBackend(dir, 'kept/app.json').listWorkspaces()).resolves.toEqual(['default', 'dev']);
    });

    it('are the default one alone where a file stands in place of their folder', async () => {
      await fs.writeFile(path.join(dir, 'clay.workspaces'), '', 'utf8');

      await expect(new LocalBackend(dir).listWorkspaces()).resolves.toEqual(['default']);
    });
  });

  describe('a file it makes only where none is', () => {
    const lockInfo = { id: 'run', operation: 'plan', who: 'me', host: 'here', pid: 1, created: 'now' };
    const rounds = 100;

    it('is never there empty while the lock is taken', async () => {
      const backend = new LocalBackend(dir);

      const empty = await emptySeen(path.join(dir, 'clay.state.json.lock'), async () => {
        for (let round = 0; round < rounds; round++) {
          await backend.lock(lockInfo);
          await backend.unlock('run');
        }
      });

      expect(empty).toBe(0);
    });

    it('is never there empty while a first state is written', async () => {
      const backend = new LocalBackend(dir);
      const state = path.join(dir, 'clay.state.json');

      const empty = await emptySeen(state, async () => {
        for (let round = 0; round < rounds; round++) {
          await backend.writeIfAbsent(emptyState());
          await fs.rm(state);
        }
      });

      expect(empty).toBe(0);
    });

    it('leaves nothing beside it, whether it made the file or found one there', async () => {
      const backend = new LocalBackend(dir);

      await backend.lock(lockInfo);
      await expect(backend.lock({ ...lockInfo, id: 'other' })).rejects.toThrow('State is locked by plan of me on here');
      expect(await backend.writeIfAbsent(emptyState())).toBe(true);
      expect(await backend.writeIfAbsent(emptyState())).toBe(false);

      const left = await fs.readdir(dir);
      expect(left.sort()).toEqual(['clay.state.json', 'clay.state.json.lock']);
    });
  });
});
