import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalBackend } from '../src/backends/LocalBackend';
import { LockInfo, LockNotReleased, newLockInfo } from '../src/lockInfo';
import { StateManager } from '../src/StateManager';

/** A process that has exited, so its pid names none. */
const gonePid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;

describe('the state lock', () => {
  let dir: string;
  let manager: StateManager;

  const lockPath = () => path.join(dir, 'clay.state.json.lock');
  const held = async () => JSON.parse(await fs.readFile(lockPath(), 'utf8')) as LockInfo;
  const leave = (info: unknown) => fs.writeFile(lockPath(), JSON.stringify(info));
  const holder = (changes: Partial<LockInfo> = {}): LockInfo => ({ ...newLockInfo('state rm'), created: '2026-11-06T10:00:00.000Z', ...changes });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-lock-test-'));
    manager = new StateManager(new LocalBackend(dir));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('says which run took it, where, and when', async () => {
    const before = Date.now();
    await manager.lock('apply');

    const info = await held();
    expect(info).toMatchObject({ operation: 'apply', who: os.userInfo().username, host: os.hostname(), pid: process.pid });
    expect(Date.parse(info.created)).toBeGreaterThanOrEqual(before);
    expect(info.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('has a new id each time it is taken', async () => {
    await manager.lock('apply');
    const { id: first } = await held();
    await manager.unlock();
    await manager.lock('apply');

    const { id: second } = await held();
    expect(second).not.toBe(first);
  });

  it('names the user unknown where the system has no entry for them', async () => {
    vi.spyOn(os, 'userInfo').mockImplementation(() => {
      throw Object.assign(new Error('no such user'), { code: 'ERR_SYSTEM_ERROR' });
    });

    await manager.lock('apply');

    const { who } = await held();
    expect(who).toBe('unknown');
  });

  it('passes on any other failure to find the user', async () => {
    vi.spyOn(os, 'userInfo').mockImplementation(() => {
      throw new Error('broken');
    });

    await expect(manager.lock('apply')).rejects.toThrow('broken');
  });

  it('refuses a second run and names the run that holds it', async () => {
    const live = holder();
    await leave(live);

    await expect(manager.lock('apply')).rejects.toThrow(
      `State is locked by state rm of ${live.who} on ${live.host}, pid ${process.pid}, since 2026-11-06T10:00:00.000Z. If that run is gone, run clay force-unlock ${live.id}`
    );
  });

  it('says the run looks gone when no process of its pid runs on this machine', async () => {
    const pid = gonePid();
    const gone = holder({ pid });
    await leave(gone);

    await expect(manager.lock('apply')).rejects.toThrow(
      `State is locked by state rm of ${gone.who} on ${gone.host}, pid ${pid}, since 2026-11-06T10:00:00.000Z. No process ${pid} runs on this machine, so that run looks gone. If it is, run clay force-unlock ${gone.id}`
    );
  });

  it('cannot tell whether a run on another machine is gone', async () => {
    await leave(holder({ host: 'elsewhere', pid: gonePid() }));

    await expect(manager.lock('apply')).rejects.toThrow(/on elsewhere, .*\. If that run is gone, run clay force-unlock /);
  });

  it("takes a process of another user's as running", async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });
    await leave(holder({ pid: gonePid() }));

    await expect(manager.lock('apply')).rejects.toThrow(/\. If that run is gone, run clay force-unlock /);
  });

  it('passes on any other failure to look for the process', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('bad signal'), { code: 'EINVAL' });
    });
    await leave(holder());

    await expect(manager.lock('apply')).rejects.toThrow('bad signal');
  });

  // A pid of 0 or below would ask `kill` about a process group, which is always there.
  it.each([
    ['an empty file', ''],
    ['text that is not JSON', 'locked'],
    ['a list', '[]'],
    ['no host', JSON.stringify({ ...newLockInfo('apply'), host: undefined })],
    ['a pid that is text', JSON.stringify({ ...newLockInfo('apply'), pid: '42' })],
    ['a pid of 0', JSON.stringify({ ...newLockInfo('apply'), pid: 0 })],
    ['a pid of -1', JSON.stringify({ ...newLockInfo('apply'), pid: -1 })],
  ])('says nothing of who holds a lock that holds %s', async (_, content) => {
    await fs.writeFile(lockPath(), content);

    await expect(manager.lock('apply')).rejects.toThrow(`State is locked by a run that left no word of who it is. If that run is gone, remove ${lockPath()}`);
  });

  describe('released', () => {
    const other = holder({ operation: 'apply' });

    it('takes away the lock this run took', async () => {
      await manager.lock('apply');

      await manager.unlock();

      await expect(fs.access(lockPath())).rejects.toThrow(/ENOENT/);
    });

    it("leaves the lock of a run that took it after this one's was removed, and says so", async () => {
      await manager.lock('apply');
      await leave(other);

      await expect(manager.unlock()).rejects.toThrow(`${lockPath()} holds a lock this run did not take, so it is left in place`);
      expect(await held()).toEqual(other);
    });

    it('names a failed release as a lock left, keeping why it failed', async () => {
      await manager.lock('apply');
      await leave(other);

      const thrown: unknown = await manager.unlock().catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(LockNotReleased);
      expect((thrown as LockNotReleased).cause).toBeInstanceOf(Error);
      expect((thrown as LockNotReleased).message).toBe(`${lockPath()} holds a lock this run did not take, so it is left in place`);
    });

    it('leaves a lock that says nothing of who took it', async () => {
      await manager.lock('apply');
      await fs.writeFile(lockPath(), '');

      await expect(manager.unlock()).rejects.toThrow('holds a lock this run did not take');
      expect(await fs.readFile(lockPath(), 'utf8')).toBe('');
    });

    it('leaves the lock of another run where this one took none', async () => {
      await leave(other);

      await manager.unlock();

      expect(await held()).toEqual(other);
    });

    it("is done once: a second unlock leaves the next run's lock", async () => {
      await manager.lock('apply');
      await manager.unlock();
      await leave(other);

      await manager.unlock();

      expect(await held()).toEqual(other);
    });

    it('after a failure, throws that failure again', async () => {
      const failure = new Error('the run failed');
      await manager.lock('apply');

      await expect(manager.unlockAfter(failure)).rejects.toBe(failure);
      await expect(fs.access(lockPath())).rejects.toThrow(/ENOENT/);
    });

    it('after a failure, keeps it beside the error of an unlock that fails too', async () => {
      const failure = new Error('the run failed');
      await manager.lock('apply');
      await leave(other);

      const thrown: unknown = await manager.unlockAfter(failure).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(AggregateError);
      const [first, second] = (thrown as AggregateError).errors as Error[];
      expect(first).toBe(failure);
      expect(second.message).toBe(`${lockPath()} holds a lock this run did not take, so it is left in place`);
      expect(await held()).toEqual(other);
    });

    it('names a lock that cannot be read, and leaves it', async () => {
      await manager.lock('apply');
      await fs.rm(lockPath());
      await fs.mkdir(lockPath());

      await expect(manager.unlock()).rejects.toThrow(`The lock ${lockPath()} cannot be read (EISDIR)`);
      const left = await fs.stat(lockPath());
      expect(left.isDirectory()).toBe(true);
    });

    // As Ctrl-C does, which may come while the lock file is being written.
    it('takes away a lock that was still being taken when unlock was asked for', async () => {
      const taking = manager.lock('plan');

      await manager.unlock();
      await taking;

      await expect(fs.access(lockPath())).rejects.toThrow(/ENOENT/);
    });

    it('is done when the lock was removed and nothing took its place', async () => {
      await manager.lock('apply');
      await fs.rm(lockPath());

      await manager.unlock();

      await expect(fs.access(lockPath())).rejects.toThrow(/ENOENT/);
    });
  });

  describe('held', () => {
    it('is false before the lock is taken, true once it is, and false once it is released', async () => {
      expect(manager.held).toBe(false);
      await manager.lock('apply');
      expect(manager.held).toBe(true);
      await manager.unlock();
      expect(manager.held).toBe(false);
    });

    it('is false when another run holds the lock', async () => {
      await leave(holder());

      await expect(manager.lock('apply')).rejects.toThrow('State is locked');
      expect(manager.held).toBe(false);
    });
  });

  it('names a lock that cannot be read', async () => {
    await fs.mkdir(lockPath());

    await expect(manager.lock('apply')).rejects.toThrow(`The lock ${lockPath()} cannot be read (EISDIR)`);
  });

  describe('forced open', () => {
    it('removes the lock of a run that is gone', async () => {
      const gone = holder();
      await leave(gone);

      await new LocalBackend(dir).forceUnlock(gone.id);

      await expect(fs.access(lockPath())).rejects.toThrow(/ENOENT/);
    });

    it('leaves a lock with another id in place', async () => {
      const other = holder();
      await leave(other);

      await expect(new LocalBackend(dir).forceUnlock('another')).rejects.toThrow(`${lockPath()} holds lock ${other.id}, not another, so it is left in place`);
      expect(await held()).toEqual(other);
    });

    it('leaves a lock that names no run in place', async () => {
      await fs.writeFile(lockPath(), 'locked');

      await expect(new LocalBackend(dir).forceUnlock('another')).rejects.toThrow(`${lockPath()} holds a lock that names no run, not another, so it is left in place`);
      expect(await fs.readFile(lockPath(), 'utf8')).toBe('locked');
    });

    it('says no lock is held where none is', async () => {
      await expect(new LocalBackend(dir).forceUnlock('another')).rejects.toThrow(`No lock is held at ${lockPath()}`);
    });
  });
});
