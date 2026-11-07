import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importCycles } from './importCycles';

const ROOT = path.join(__dirname, '..');
const SOURCES = ['packages', 'providers']
  .flatMap((dir) => readdirSync(path.join(ROOT, dir)).map((name) => path.join(dir, name, 'src')))
  .filter((src) => existsSync(path.join(ROOT, src)));

describe('import cycles', () => {
  it('are looked for in every package', () => {
    expect(SOURCES).toEqual(expect.arrayContaining(['packages/orchestrator/src', 'packages/parser/src', 'packages/state/src', 'providers/local/src']));
  });

  it.each(SOURCES)('%s has none, between files or between folders', (src) => {
    expect(importCycles(path.join(ROOT, src))).toEqual({ files: [], folders: [] });
  });

  describe('in a tree of files', () => {
    let src: string;

    beforeEach(() => {
      src = mkdtempSync(path.join(os.tmpdir(), 'clay-import-cycles-'));
    });

    afterEach(() => rmSync(src, { recursive: true, force: true }));

    function write(files: Record<string, string>): void {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(src, name)), { recursive: true });
        writeFileSync(path.join(src, name), text);
      }
    }

    it('names the files that import one another, and none that only imports them or is only imported', () => {
      write({ 'a.ts': "import { b } from './b';", 'b.ts': "import { a } from './a';\nimport { d } from './d';", 'c.ts': "import { a } from './a';", 'd.ts': '' });

      expect(importCycles(src)).toEqual({ files: [['a.ts', 'b.ts']], folders: [] });
    });

    it('names folders that import one another, though no two files do', () => {
      write({ 'one/a.ts': "import { b } from '../two/b';", 'two/b.ts': "import { c } from '../one/c';", 'one/c.ts': '' });

      expect(importCycles(src)).toEqual({ files: [], folders: [['one', 'two']] });
    });

    it('names a folder and the file beside it that import one another', () => {
      write({ 'a.ts': "import { b } from './lib';", 'lib/index.ts': "import { c } from '../c';", 'c.ts': "import { a } from './a';" });

      expect(importCycles(src)).toEqual({ files: [['a.ts', 'c.ts', 'lib/index.ts']], folders: [['a.ts', 'c.ts', 'lib']] });
    });

    it('counts a type import and an export from as imports', () => {
      write({ 'a.ts': "import type { B } from './b';", 'b.ts': "export * from './a';" });

      expect(importCycles(src)).toEqual({ files: [['a.ts', 'b.ts']], folders: [] });
    });

    it('leaves out an import of a package', () => {
      write({ 'a.ts': "import { b } from '@clay/b';" });

      expect(importCycles(src)).toEqual({ files: [], folders: [] });
    });

    it('refuses an import of a file that is not there, which would hide a cycle', () => {
      write({ 'a.ts': "import { b } from './b';" });

      expect(() => importCycles(src)).toThrow(`${path.join(src, 'a.ts')} imports ./b, which is no file`);
    });
  });
});
