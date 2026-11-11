import { STATE_VERSION } from '@clay/contracts';
import { LocalBackend, newLockInfo } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInitCommand } from '../../../src/commands/init';

const init = () => createInitCommand().parseAsync(['node', 'clay', 'init']);

// init works on the current directory, so the tests run it from a temp one.
describe('init against real files', () => {
  let dir: string;
  let cwd: string;

  const stateWithResource = {
    version: STATE_VERSION,
    serial: 0,
    resources: { 'local_file.a': { id: 'a.txt', resourceType: 'local_file', name: 'a', attributes: { content: 'hello' } } },
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-init-'));
    cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('starts an empty state in a new workspace and leaves nothing else behind', async () => {
    await init();

    expect(await new LocalBackend(dir).read()).toEqual({ version: STATE_VERSION, serial: 0, resources: {} });
    expect(await fs.readdir(dir)).toEqual(['clay.state.json']);
  });

  it('says what it found when it runs again', async () => {
    await init();
    await init();

    const printed = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(printed).toContain('Kept the state already here');
  });

  it('keeps the resources a second init finds', async () => {
    await new LocalBackend(dir).write(stateWithResource);

    await init();

    expect(await new LocalBackend(dir).read()).toEqual(stateWithResource);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('Kept the state already here');
  });

  it('writes no state while another run holds the lock, and leaves that lock', async () => {
    const lock = JSON.stringify({ ...newLockInfo('apply'), host: 'elsewhere' });
    await fs.writeFile(path.join(dir, 'clay.state.json.lock'), lock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // init exits the process when it fails, which would take the test runner with it.
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    await init();

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('State is locked by apply');
    expect(await fs.readdir(dir)).toEqual(['clay.state.json.lock']);
    expect(await fs.readFile(path.join(dir, 'clay.state.json.lock'), 'utf8')).toBe(lock);
  });
});
