import { emptyState } from '@clay/contracts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalBackend } from '../src/backends/LocalBackend';
import { emptySeen } from './emptySeen';

describe('LocalBackend', () => {
  let dir: string;

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
