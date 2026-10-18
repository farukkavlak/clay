import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';

import { emptyState, State, STATE_VERSION } from '@clay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalBackend } from '../src/backends/LocalBackend';
import { StateBackend } from '../src/StateBackend';
import { StateManager } from '../src/StateManager';

/** A backend that takes a moment to write and notes when two writes overlap. */
const slow = (log: string[], failing: number[] = []): StateBackend => {
  let running = 0;
  let calls = 0;

  return {
    read: async () => emptyState(),
    writeIfAbsent: () => Promise.resolve(true),
    lock: () => Promise.resolve(),
    unlock: () => Promise.resolve(),
    write: async (state) => {
      const call = ++calls;
      log.push(`start ${state.serial}`);
      running += 1;
      if (running > 1) log.push('overlap');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      running -= 1;
      log.push(`end ${state.serial}`);
      if (failing.includes(call)) throw new Error(`write ${call} failed`);
    },
  };
};

describe('StateManager', () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-state-test-'));
    const backend = new LocalBackend(tmpDir, 'test.state.json');
    stateManager = new StateManager(backend);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should return default empty state if file does not exist', async () => {
    const state = await stateManager.read();
    expect(state).toEqual({ version: STATE_VERSION, serial: 0, resources: {} });
  });

  it('should write and read state correctly', async () => {
    const mockState: State = {
      version: STATE_VERSION,
      serial: 0,
      resources: {
        'mock_resource.test_a': {
          resourceType: 'mock_resource',
          name: 'test_a',
          attributes: { filename: 'foo.txt' },
        },
      },
    };

    await stateManager.write(mockState);

    const fileContent = await fs.readFile(path.join(tmpDir, 'test.state.json'));
    expect(JSON.parse(fileContent.toString('utf8'))).toEqual(mockState);

    const readState = await stateManager.read();
    expect(readState).toEqual(mockState);
  });

  it('keeps the deposed objects it is given, on disk and when read back', async () => {
    const withDeposed: State = {
      version: STATE_VERSION,
      serial: 0,
      resources: {},
      deposed: { 'mock_resource.test_a': [{ attributes: { filename: 'old.txt' }, sensitive: [['filename']], dependencies: ['mock_resource.b'] }] },
    };

    await stateManager.write(withDeposed);

    const fileContent = await fs.readFile(path.join(tmpDir, 'test.state.json'));
    expect(JSON.parse(fileContent.toString('utf8'))).toEqual(withDeposed);
    expect(await stateManager.read()).toEqual(withDeposed);
  });

  it('counts every write in the serial, on disk and in the state it was given', async () => {
    const state: State = { version: STATE_VERSION, serial: 0, resources: {} };

    await stateManager.write(state);
    await stateManager.write(state);

    const stored = await stateManager.read();
    expect(state.serial).toBe(2);
    expect(stored.serial).toBe(2);
  });

  describe('writes started together', () => {
    it('go one after another, each with its own serial', async () => {
      const log: string[] = [];
      const manager = new StateManager(slow(log));
      const state = emptyState();

      await Promise.all([manager.write(state), manager.write(state), manager.write(state)]);

      expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
    });

    it('keep 20 writes started together whole', async () => {
      const manager = new StateManager(new LocalBackend(tmpDir, 'test.state.json'));
      const state = emptyState();
      const writes: Promise<void>[] = [];

      for (let index = 0; index < 20; index++) {
        state.resources[`mock_resource.r${index}`] = { resourceType: 'mock_resource', name: `r${index}`, attributes: {} };
        writes.push(manager.write(state));
      }
      await Promise.all(writes);

      const stored = await manager.read();
      expect(stored.serial).toBe(20);
      expect(Object.keys(stored.resources)).toHaveLength(20);
    });

    it('write the state as it is when their turn comes', async () => {
      const manager = new StateManager(new LocalBackend(tmpDir, 'test.state.json'));
      const state = emptyState();

      const writes = [manager.write(state), manager.write(state)];
      state.resources['mock_resource.late'] = { resourceType: 'mock_resource', name: 'late', attributes: {} };
      await Promise.all(writes);

      const stored = await manager.read();
      expect(Object.keys(stored.resources)).toEqual(['mock_resource.late']);
    });

    it('reach the backend after one before them failed', async () => {
      const log: string[] = [];
      const manager = new StateManager(slow(log, [1]));
      const state = emptyState();

      const [first, second] = await Promise.allSettled([manager.write(state), manager.write(state)]);

      expect(first).toMatchObject({ status: 'rejected', reason: { message: 'write 1 failed' } });
      expect(second.status).toBe('fulfilled');
      expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
    });
  });

  // The state may now hold what the older version cannot read.
  it('writes the version of this Clay, whatever version the state was read at', async () => {
    const state: State = { version: STATE_VERSION - 1, serial: 0, resources: {} };

    await stateManager.write(state);

    const stored = await stateManager.read();
    expect(stored.version).toBe(STATE_VERSION);
    expect(state.version).toBe(STATE_VERSION);
  });

  describe('writeIfAbsent', () => {
    const empty: State = { version: STATE_VERSION, serial: 0, resources: {} };

    it('should write the state when none is stored yet', async () => {
      expect(await stateManager.writeIfAbsent(empty)).toBe(true);
      expect(await stateManager.read()).toEqual(empty);
    });

    it('should keep the stored state and say it wrote nothing', async () => {
      const stored: State = { version: STATE_VERSION, serial: 0, resources: { 'mock_resource.a': { resourceType: 'mock_resource', name: 'a', attributes: {} } } };
      await stateManager.write(stored);

      expect(await stateManager.writeIfAbsent(empty)).toBe(false);
      expect(await stateManager.read()).toEqual(stored);
    });

    it('should throw when the state cannot be written at all', async () => {
      const missingDir = new StateManager(new LocalBackend(path.join(tmpDir, 'missing'), 'test.state.json'));

      await expect(missingDir.writeIfAbsent(empty)).rejects.toThrow();
    });
  });

  it('should throw error for non-ENOENT errors', async () => {
    // A directory at the state path makes the read fail with EISDIR.
    const statePath = path.join(tmpDir, 'test.state.json');
    await fs.mkdir(statePath);

    await expect(stateManager.read()).rejects.toThrow();
  });

  describe('Locking', () => {
    it('should create a lock file', async () => {
      await stateManager.lock();
      const lockPath = path.join(tmpDir, 'test.state.json.lock');
      const lockFile = await fs.stat(lockPath);
      expect(lockFile.isFile()).toBe(true);
    });

    it('should throw if already locked', async () => {
      await stateManager.lock();
      await expect(stateManager.lock()).rejects.toThrow(/locked by another run/i);
    });

    it('should remove lock file on unlock', async () => {
      await stateManager.lock();
      await stateManager.unlock();
      const lockPath = path.join(tmpDir, 'test.state.json.lock');
      await expect(fs.stat(lockPath)).rejects.toThrow(/ENOENT/);
    });

    it('should accept unlock even if not locked', async () => {
      await expect(stateManager.unlock()).resolves.not.toThrow();
    });

    it('should re-throw generic errors during lock', async () => {
      // A missing directory makes the write fail with ENOENT, which is not EEXIST, so it is rethrown.
      const invalidBackend = new LocalBackend('/non/existent/path/xyz/123');
      const invalidManager = new StateManager(invalidBackend);
      await expect(invalidManager.lock()).rejects.toThrow(/ENOENT/);
    });

    it('should re-throw generic errors during unlock', async () => {
      // A directory at the lock path makes the unlink fail with EISDIR or EPERM.
      const lockPath = path.join(tmpDir, 'test.state.json.lock');
      await fs.mkdir(lockPath);

      await expect(stateManager.unlock()).rejects.toThrow();
    });
  });

  describe('Backup', () => {
    it('should create a backup file before writing if state exists', async () => {
      const state1 = { version: STATE_VERSION, serial: 0, resources: { a: { resourceType: 'rt', name: 'n', attributes: {} } } };
      const state2 = { version: STATE_VERSION, serial: 0, resources: {} };

      // The first write has nothing to back up.
      await stateManager.write(state1);
      const bakPath = path.join(tmpDir, 'test.state.json.bak');
      await expect(fs.stat(bakPath)).rejects.toThrow(/ENOENT/);

      await stateManager.write(state2);

      const bakContent = await fs.readFile(bakPath);
      expect(JSON.parse(bakContent.toString('utf8'))).toEqual(state1);

      const currentContent = await fs.readFile(path.join(tmpDir, 'test.state.json'));
      expect(JSON.parse(currentContent.toString('utf8'))).toEqual(state2);
    });
  });

  describe('a backup that cannot be written', () => {
    it('stops the write and leaves the state as it was', async () => {
      const first: State = { version: STATE_VERSION, serial: 1, resources: {} };
      const second: State = { version: STATE_VERSION, serial: 2, resources: {} };
      await stateManager.write(first);
      await stateManager.write(second);

      // A directory at the backup path makes the copy fail with something other than ENOENT.
      const bakPath = path.join(tmpDir, 'test.state.json.bak');
      await fs.rm(bakPath);
      await fs.mkdir(bakPath);

      const statePath = path.join(tmpDir, 'test.state.json');
      await expect(stateManager.write({ version: STATE_VERSION, serial: 3, resources: {} })).rejects.toThrow(
        `Could not back up ${statePath} to ${statePath}.bak (EISDIR); the state was not written`
      );
      expect(await stateManager.read()).toEqual(second);
    });
  });

  describe('a write that fails halfway', () => {
    it('leaves the state that was there, whole', async () => {
      const before: State = { version: STATE_VERSION, serial: 0, resources: { 'mock_resource.a': { resourceType: 'mock_resource', name: 'a', attributes: {} } } };
      await stateManager.write(before);

      // A directory at the temp path makes the write fail before the state file is touched.
      await fs.mkdir(path.join(tmpDir, 'test.state.json.tmp'));

      await expect(stateManager.write({ version: STATE_VERSION, serial: 5, resources: {} })).rejects.toThrow();
      expect(await stateManager.read()).toEqual(before);
    });

    it('leaves nothing beside the state file when it succeeds', async () => {
      await stateManager.write({ version: STATE_VERSION, serial: 0, resources: {} });

      expect(await fs.readdir(tmpDir)).toEqual(['test.state.json']);
    });
  });
});
