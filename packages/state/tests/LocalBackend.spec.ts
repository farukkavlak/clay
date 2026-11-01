import { emptyState } from '@clay/contracts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalBackend } from '../src/backends/LocalBackend';

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
});
