import { LocalBackend } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { orchestratorIn, TestEngine } from '../helpers';
import { Slow } from '../slow';
import { start } from '../start';

const blocks = (...names: string[]) => names.map((name) => `resource "slow" "${name}" {\n  name = "${name}"\n}`).join('\n');

describe('a layer of resources', () => {
  let dir: string;
  let provider: Slow;
  let engine: TestEngine;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-parallel-'));
    provider = new Slow();
    engine = orchestratorIn(dir, provider);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const run = async (config: string): Promise<string[]> => {
    const events: string[] = [];
    for await (const event of start(engine, config)) events.push('action' in event ? `${event.type} ${event.action.name}` : event.type);

    return events;
  };

  const runWith = async (config: string, parallelism: number): Promise<void> => {
    for await (const event of engine.runPlan(await engine.plan(config), config, { parallelism })) if (event.type === 'failed') throw event.error;
  };

  const held = async () => {
    const { resources } = await new LocalBackend(dir).read();
    return Object.keys(resources).sort();
  };

  it('is made together', async () => {
    await run(blocks('a', 'b', 'c', 'd'));

    expect(provider.most).toBe(4);
    expect(await held()).toEqual(['slow.a', 'slow.b', 'slow.c', 'slow.d']);
  });

  it('is made ten at a time', async () => {
    const names = Array.from({ length: 12 }, (_, index) => `r${index}`);

    await run(blocks(...names));

    expect(provider.most).toBe(10);
    expect(await held()).toHaveLength(12);
  });

  describe('with a parallelism given', () => {
    it.each([1, 2, 4])('is made %i at a time', async (parallelism) => {
      await runWith(blocks('a', 'b', 'c', 'd'), parallelism);

      expect(provider.most).toBe(parallelism);
      expect(await held()).toEqual(['slow.a', 'slow.b', 'slow.c', 'slow.d']);
    });

    it('is destroyed as many at a time too', async () => {
      await runWith(blocks('a', 'b', 'c'), 3);
      provider.most = 0;

      await runWith('', 2);

      expect(provider.most).toBe(2);
      expect(await held()).toEqual([]);
    });

    it.each([0, -1, 2.5, Number.NaN])('refuses %s before anything is made or locked', async (parallelism) => {
      await expect(runWith(blocks('a'), parallelism)).rejects.toThrow(`parallelism is a whole number from 1, not ${parallelism}`);

      expect(provider.most).toBe(0);
      expect(await held()).toEqual([]);
      await expect(fs.access(path.join(dir, 'clay.state.json.lock'))).rejects.toThrow();
    });
  });

  it('waits for the resource it reads', async () => {
    await run(`${blocks('a')}\nresource "slow" "b" {\n  name = "b"\n  note = slow.a.name\n}`);

    expect(provider.most).toBe(1);
    expect(await held()).toEqual(['slow.a', 'slow.b']);
  });

  it('is destroyed together', async () => {
    await run(blocks('a', 'b', 'c'));
    provider.most = 0;

    await run('');

    expect(provider.most).toBe(3);
    expect(await held()).toEqual([]);
  });

  describe('when one fails', () => {
    // The failing one comes first, so a run one at a time would stop before it made the others.
    const config = `resource "slow" "aa" {\n  name = "aa"\n  mode = "fails"\n}\n${blocks('x', 'y')}\nresource "slow" "after" {\n  name = "after"\n  note = slow.x.name\n}`;

    it('keeps the others it started, starts nothing more, and reports the failure last', async () => {
      const events = await run(config);

      expect(events.at(-1)).toBe('failed aa');
      expect(events).toContain('applied x');
      expect(events).toContain('applied y');
      expect(events).not.toContain('started after');
      expect(await held()).toEqual(['slow.x', 'slow.y']);
    });
  });
});
