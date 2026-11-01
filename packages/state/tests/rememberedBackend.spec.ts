import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adoptBackend, checkBackend, LocalBackend } from '../src';

describe('the backend init remembers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-remembered-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is not taken while a journal alone is left at the old place', async () => {
    await fs.writeFile(path.join(dir, 'clay.state.json.journal'), 'line\n', 'utf8');

    await expect(adoptBackend(new LocalBackend(dir, 'other.json'), dir)).rejects.toThrow('The state in "clay.state.json" would be left behind');
    await expect(fs.access(path.join(dir, '.clay'))).rejects.toThrow('ENOENT');
  });

  it('leaves only the record behind it', async () => {
    await adoptBackend(new LocalBackend(dir, 'other.json'), dir);

    expect(await fs.readdir(path.join(dir, '.clay'))).toEqual(['backend.json']);
    expect(() => checkBackend(new LocalBackend(dir, 'other.json'), dir)).not.toThrow();
    expect(() => checkBackend(new LocalBackend(dir), dir)).toThrow('keeps its state in "other.json"');
  });

  it('passes on a record it cannot read, rather than taking it as no record', async () => {
    await fs.mkdir(path.join(dir, '.clay', 'backend.json'), { recursive: true });

    expect(() => checkBackend(new LocalBackend(dir), dir)).toThrow('EISDIR');
  });

  it('passes on a place it cannot ask about, rather than taking it as nothing there', async () => {
    await expect(new LocalBackend(dir, 'x'.repeat(300)).check()).rejects.toThrow('ENAMETOOLONG');
  });
});
