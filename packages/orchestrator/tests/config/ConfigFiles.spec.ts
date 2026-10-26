import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigFiles, DiskFiles, InMemoryFiles, RecordingFiles } from '../../src/config/ConfigFiles';

describe('DiskFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-files-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lists what a directory holds, without its directories', async () => {
    await fs.mkdir(path.join(dir, 'm', 'sub.clay'), { recursive: true });
    await fs.writeFile(path.join(dir, 'm', 'a.clay'), '', 'utf8');
    await fs.writeFile(path.join(dir, 'm', 'notes.txt'), '', 'utf8');

    expect(new DiskFiles(dir).list('m').sort()).toEqual(['a.clay', 'notes.txt']);
  });

  it('lists a link to a file and a link it cannot follow, but not a link to a directory', async () => {
    await fs.mkdir(path.join(dir, 'sub'));
    await fs.writeFile(path.join(dir, 'real.clay'), '', 'utf8');
    await fs.symlink('real.clay', path.join(dir, 'file.clay'));
    await fs.symlink('nowhere', path.join(dir, 'gone.clay'));
    await fs.symlink('loop.clay', path.join(dir, 'loop.clay'));
    await fs.symlink('sub', path.join(dir, 'dir.clay'));

    expect(new DiskFiles(dir).list('.').sort()).toEqual(['file.clay', 'gone.clay', 'loop.clay', 'real.clay']);
  });

  it.each([
    ['a directory that is not there', 'missing'],
    ['a file', 'a.clay'],
  ])('lists nothing in %s', async (_, listed) => {
    await fs.writeFile(path.join(dir, 'a.clay'), '', 'utf8');

    expect(new DiskFiles(dir).list(listed)).toEqual([]);
  });
});

describe('InMemoryFiles', () => {
  it('lists the files directly in a directory', () => {
    const files = new InMemoryFiles({ 'main.clay': '', 'a/x.clay': '', 'a/b/y.clay': '' });

    expect(files.list('.')).toEqual(['main.clay']);
    expect(files.list('a')).toEqual(['x.clay']);
  });
});

describe('RecordingFiles', () => {
  it('gives the content it read first when the file changes after', () => {
    let content = 'first';
    const source: ConfigFiles = { read: () => content, list: () => [] };
    const files = new RecordingFiles(source);

    files.read('main.clay');
    content = 'second';

    expect(files.read('main.clay')).toBe('first');
  });

  it('gives the listing it made first when the directory changes after', () => {
    let names = ['a.clay'];
    const files = new RecordingFiles({ read: () => '', list: () => names });

    files.list('.');
    names = ['a.clay', 'b.clay'];

    expect(files.list('.')).toEqual(['a.clay']);
  });
});
