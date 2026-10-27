import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { orchestratorIn, TestEngine } from '../helpers';
import { Slow } from '../slow';
import { start } from '../start';

const blocks = (...names: string[]) => names.map((name) => `resource "slow" "${name}" {\n  name = "${name}"\n}`).join('\n');

/** A resource the provider fails to read, at once or after the others' reads. */
const unread = (name: string, mode: 'unread' | 'unread late') => `resource "slow" "${name}" {\n  name = "${name}"\n  mode = "${mode}"\n}`;

describe('a refresh', () => {
  let dir: string;
  let provider: Slow;
  let engine: TestEngine;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-parallel-plan-'));
    provider = new Slow(['read']);
    engine = orchestratorIn(dir, provider);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const applied = async (config: string) => {
    for await (const event of start(engine, config)) if (event.type === 'failed') throw event.error;
    provider.most = 0;
    provider.reads = 0;
  };

  it('reads what state holds ten at a time', async () => {
    const config = blocks(...Array.from({ length: 12 }, (_, index) => `r${index}`));
    await applied(config);

    const { actions } = await engine.plan(config);

    expect(provider.most).toBe(10);
    expect(actions.filter(({ type }) => type === 'NO_OP')).toHaveLength(12);
  });

  it.each([1, 3])('reads %i at a time where it is told to', async (parallelism) => {
    const config = blocks('a', 'b', 'c', 'd');
    await applied(config);

    await engine.plan(config, { parallelism });

    expect(provider.most).toBe(parallelism);
  });

  it.each([0, -1, 2.5, Number.NaN])('refuses %s before it reads anything', async (parallelism) => {
    const config = blocks('a');
    await applied(config);

    await expect(engine.plan(config, { parallelism })).rejects.toThrow(`parallelism is a whole number from 1, not ${parallelism}`);
    expect(provider.reads).toBe(0);
  });

  it('names the resource it cannot read', async () => {
    const config = `${blocks('a')}\n${unread('b', 'unread')}`;
    await applied(config);

    await expect(engine.plan(config)).rejects.toThrow('slow.b: b cannot be read');
  });

  // `a` fails last, so a refresh that reported the first failure to come would name `b`.
  it('names the first resource in state it cannot read, not the first read to fail', async () => {
    const config = `${unread('a', 'unread late')}\n${unread('b', 'unread')}`;
    await applied(config);

    await expect(engine.plan(config)).rejects.toThrow('slow.a: a cannot be read');
  });
});
