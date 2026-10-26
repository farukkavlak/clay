import { LocalBackend } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { orchestratorIn } from '../helpers';
import { start } from '../start';

const PAIRS = `
  resource "null_resource" "a" {
    count = 1000
  }

  resource "null_resource" "b" {
    count    = 1000
    triggers = { a = null_resource.a[count.index].id }
  }
`;

describe('what an object read, as state keeps it', () => {
  let dir: string;

  const apply = async (config: string) => {
    for await (const event of start(orchestratorIn(dir), config)) if (event.type === 'failed') throw event.error;
  };
  const dependenciesOf = async (address: string) => {
    const state = await new LocalBackend(dir).read();
    return state.resources[address].dependencies;
  };
  const module = async (name: string, config: string) => {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(path.join(dir, name, 'main.clay'), config, 'utf8');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-dependencies-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is the block, not each of its instances', async () => {
    await apply(PAIRS);

    expect(await dependenciesOf('null_resource.b[5]')).toEqual(['null_resource.a']);
    // Each instance listing all 1000 of the other made 32 MB.
    const { size } = await fs.stat(path.join(dir, 'clay.state.json'));
    expect(size).toBeLessThan(1_000_000);
  });

  it('is the block in every instance of a module the reader is outside of', async () => {
    await module('m', 'resource "null_resource" "a" {}\noutput "id" {\n  value = null_resource.a.id\n}\n');

    await apply('module "m" {\n  source = "./m"\n  count  = 3\n}\nresource "null_resource" "b" {\n  count    = 3\n  triggers = { m = module.m[count.index].id }\n}\n');

    expect(await dependenciesOf('null_resource.b[1]')).toEqual(['module.m.null_resource.a']);
  });

  it('keeps the module instance the reader shares with it, and every instance below that', async () => {
    await module('p/q', 'resource "null_resource" "a" {}\noutput "id" {\n  value = null_resource.a.id\n}\n');
    await module('p', 'module "q" {\n  source = "./q"\n  count  = 2\n}\nresource "null_resource" "r" {\n  triggers = { q = module.q[0].id }\n}\n');

    await apply('module "p" {\n  source = "./p"\n  count  = 2\n}\n');

    expect(await dependenciesOf('module.p[1].null_resource.r')).toEqual(['module.p[1].module.q.null_resource.a']);
  });
});
