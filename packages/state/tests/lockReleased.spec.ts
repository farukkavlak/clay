import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { LocalBackend } from '../src/backends/LocalBackend';
import { StateManager } from '../src/StateManager';

// The other run unlocking between the refused write and the read cannot be timed, so the read removes the lock first.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-lock-released-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

it('says nothing of who held a lock released just as it was read', async () => {
  const lockPath = path.join(dir, 'clay.state.json.lock');
  await fs.writeFile(lockPath, '');
  vi.mocked(fs.readFile).mockImplementationOnce(async (file) => {
    await fs.rm(lockPath);
    return fs.readFile(file);
  });

  await expect(new StateManager(new LocalBackend(dir)).lock('apply')).rejects.toThrow(
    `State is locked by a run that left no word of who it is. If that run is gone, remove ${lockPath}`
  );
});
