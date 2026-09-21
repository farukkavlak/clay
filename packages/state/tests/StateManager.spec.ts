import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';

import { IState } from '@clay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalBackend } from '../src/backends/LocalBackend';
import { StateManager } from '../src/StateManager';

describe('StateManager', () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    // Create a safe temporary directory for each test
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-state-test-'));
    const backend = new LocalBackend(tmpDir, 'test.state.json');
    stateManager = new StateManager(backend);
  });

  afterEach(async () => {
    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should return default empty state if file does not exist', async () => {
    const state = await stateManager.read();
    expect(state).toEqual({ version: 1, serial: 0, resources: {} });
  });

  it('should write and read state correctly', async () => {
    const mockState: IState = {
      version: 1,
      serial: 0,
      resources: {
        'mock_resource.test_a': {
          type: 'Resource',
          resourceType: 'mock_resource',
          name: 'test_a',
          attributes: { filename: 'foo.txt' },
        },
      },
    };

    await stateManager.write(mockState);

    // Verify file exists
    const fileContent = await fs.readFile(path.join(tmpDir, 'test.state.json'));
    expect(JSON.parse(fileContent.toString('utf8'))).toEqual(mockState);

    // Verify read method
    const readState = await stateManager.read();
    expect(readState).toEqual(mockState);
  });

  it('counts every write in the serial, on disk and in the state it was given', async () => {
    const state: IState = { version: 1, serial: 0, resources: {} };

    await stateManager.write(state);
    await stateManager.write(state);

    const stored = await stateManager.read();
    expect(state.serial).toBe(2);
    expect(stored.serial).toBe(2);
  });

  describe('writeIfAbsent', () => {
    const empty: IState = { version: 1, serial: 0, resources: {} };

    it('should write the state when none is stored yet', async () => {
      expect(await stateManager.writeIfAbsent(empty)).toBe(true);
      expect(await stateManager.read()).toEqual(empty);
    });

    it('should keep the stored state and say it wrote nothing', async () => {
      const stored: IState = { version: 1, serial: 0, resources: { 'mock_resource.a': { type: 'Resource', resourceType: 'mock_resource', name: 'a', attributes: {} } } };
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
    // Create a directory with the same name as the state file
    // This will cause fs.readFile to throw EISDIR (Is a directory)
    const statePath = path.join(tmpDir, 'test.state.json');
    await fs.mkdir(statePath);

    await expect(stateManager.read()).rejects.toThrow();
  });

  describe('Locking', () => {
    it('should create a lock file', async () => {
      await stateManager.lock();
      const lockPath = path.join(tmpDir, 'test.state.json.lock');
      // eslint-disable-next-line unicorn/no-await-expression-member
      expect((await fs.stat(lockPath)).isFile()).toBe(true);
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
      // Use a non-existent directory for workingDir
      // This causes fs.writeFile to throw ENOENT, which is not EEXIST
      // So it should be re-thrown
      const invalidBackend = new LocalBackend('/non/existent/path/xyz/123');
      const invalidManager = new StateManager(invalidBackend);
      await expect(invalidManager.lock()).rejects.toThrow(/ENOENT/);
    });

    it('should re-throw generic errors during unlock', async () => {
      // Create a directory at lock path
      // This causes fs.unlink to throw EISDIR or EPERM
      const lockPath = path.join(tmpDir, 'test.state.json.lock');
      await fs.mkdir(lockPath);

      await expect(stateManager.unlock()).rejects.toThrow();
    });
  });

  describe('Backup', () => {
    it('should create a backup file before writing if state exists', async () => {
      const state1 = { version: 1, serial: 0, resources: { a: { type: 't', resourceType: 'rt', name: 'n', attributes: {} } } };
      const state2 = { version: 2, serial: 0, resources: {} };

      // First write (no backup expected)
      await stateManager.write(state1);
      const bakPath = path.join(tmpDir, 'test.state.json.bak');
      await expect(fs.stat(bakPath)).rejects.toThrow(/ENOENT/);

      // Second write (backup expected)
      await stateManager.write(state2);

      const bakContent = await fs.readFile(bakPath);
      expect(JSON.parse(bakContent.toString('utf8'))).toEqual(state1);

      const currentContent = await fs.readFile(path.join(tmpDir, 'test.state.json'));
      expect(JSON.parse(currentContent.toString('utf8'))).toEqual(state2);
    });
  });

  describe('a write that fails halfway', () => {
    it('leaves the state that was there, whole', async () => {
      const before: IState = { version: 1, serial: 0, resources: { 'mock_resource.a': { type: 'Resource', resourceType: 'mock_resource', name: 'a', attributes: {} } } };
      await stateManager.write(before);

      // A directory in the way of the temporary file makes the write fail before the state file is touched.
      await fs.mkdir(path.join(tmpDir, 'test.state.json.tmp'));

      await expect(stateManager.write({ version: 1, serial: 5, resources: {} })).rejects.toThrow();
      expect(await stateManager.read()).toEqual(before);
    });

    it('leaves nothing beside the state file when it succeeds', async () => {
      await stateManager.write({ version: 1, serial: 0, resources: {} });

      expect(await fs.readdir(tmpDir)).toEqual(['test.state.json']);
    });
  });
});
