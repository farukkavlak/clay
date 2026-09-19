import { LocalBackend } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInitCommand } from '../../src/commands/init';

const init = () => createInitCommand().parseAsync(['node', 'clay', 'init']);

// init works on the current directory, so the tests run it from a temp one.
describe('init against real files', () => {
  let dir: string;
  let cwd: string;

  const stateWithResource = {
    version: 1,
    resources: { 'local_file.a': { id: 'a.txt', type: 'Resource', resourceType: 'local_file', name: 'a', attributes: { content: 'hello' } } },
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

  it('starts an empty state in a new workspace', async () => {
    await init();

    expect(await new LocalBackend(dir).read()).toEqual({ version: 1, resources: {} });
  });

  it('says what it found when it runs again', async () => {
    await init();
    await init();

    const printed = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(printed).toContain(`Found ${path.join(process.cwd(), '.clay')}`);
    expect(printed).toContain('Kept the state already here');
  });

  it('keeps the resources a second init finds', async () => {
    await new LocalBackend(dir).write(stateWithResource);

    await init();

    expect(await new LocalBackend(dir).read()).toEqual(stateWithResource);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('Kept the state already here');
  });
});
