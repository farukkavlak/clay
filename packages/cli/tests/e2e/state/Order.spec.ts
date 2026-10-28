import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { orchestratorIn } from '../helpers';
import { start } from '../start';

describe('the resources a state file holds', () => {
  let dir: string;

  const apply = async (config: string) => {
    for await (const event of start(orchestratorIn(dir), config)) if (event.type === 'failed') throw event.error;
  };
  const written = async () => {
    const file = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as { resources: Record<string, unknown> };
    return Object.keys(file.resources);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-order-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // `a` reads `b`, so `b` is made first.
  it('are in address order, not in the order they were made', async () => {
    await apply('resource "null_resource" "a" {\n  triggers = { b = null_resource.b.id }\n}\nresource "null_resource" "b" {}\n');

    expect(await written()).toEqual(['null_resource.a', 'null_resource.b']);
  });

  it('put the instances of a count in the order of their index', async () => {
    await apply('resource "null_resource" "r" {\n  count = 11\n}\n');

    const keys = await written();

    expect(keys.slice(0, 3)).toEqual(['null_resource.r[0]', 'null_resource.r[1]', 'null_resource.r[2]']);
    expect(keys.at(-1)).toBe('null_resource.r[10]');
  });
});
