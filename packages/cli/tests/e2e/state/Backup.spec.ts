import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clayOutput } from '../helpers';

describe('the state backup', () => {
  let dir: string;

  const nulls = (count: number) => fs.writeFile(path.join(dir, 'main.clay'), `resource "null_resource" "a" {\n  count = ${count}\n}\n`, 'utf8');
  const read = (file: string) => fs.readFile(path.join(dir, file), 'utf8');

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-backup-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is the state from before an apply that wrote several times', async () => {
    await nulls(1);
    await clayOutput(dir, 'apply', '-y');
    const before = await read('clay.state.json');

    await nulls(4);
    await clayOutput(dir, 'apply', '-y');

    expect(await read('clay.state.json.bak')).toBe(before);
  });
});
