import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { parsePlanFile, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('an apply that does what the plan showed', () => {
  let dir: string;
  let config: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const run = async (engine: Orchestrator, planned: Awaited<ReturnType<Orchestrator['plan']>>) => {
    for await (const event of engine.runPlan(planned, config)) if (event.type === 'failed') throw event.error;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-planned-'));
    await fs.writeFile(path.join(dir, 'source.txt'), 'one', 'utf8');
    config = `
      data "local_file" "source" { path = "${path.join(dir, 'source.txt')}" }
      resource "local_file" "copy" {
        path = "${path.join(dir, 'copy.txt')}"
        content = data.local_file.source.content
      }
    `;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // The data source is read again for the run, and now reads what the plan never showed.
  it('stops before a resource whose value the plan showed as known comes to another', async () => {
    const engine = newOrchestrator();
    const planned = await engine.plan(config);
    await fs.writeFile(path.join(dir, 'source.txt'), 'two', 'utf8');

    await expect(run(engine, planned)).rejects.toThrow('the plan showed content = "one", but it now comes to "two". Plan again.');
    await expect(fs.access(path.join(dir, 'copy.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops a saved plan the same way', async () => {
    const engine = newOrchestrator();
    const saved = parsePlanFile(serializePlan(await engine.plan(config), config, {}), 'plan.json');
    await fs.writeFile(path.join(dir, 'source.txt'), 'two', 'utf8');

    await expect(run(engine, saved)).rejects.toThrow('the plan showed content = "one", but it now comes to "two". Plan again.');
    await expect(fs.access(path.join(dir, 'copy.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs what the plan showed', async () => {
    const engine = newOrchestrator();

    await run(engine, await engine.plan(config));

    expect(await fs.readFile(path.join(dir, 'copy.txt'), 'utf8')).toBe('one');
  });

  // A value only an apply makes may come to anything.
  it('runs a value the plan showed as known after apply, whatever it comes to', async () => {
    config = `
      resource "random_string" "r" { length = 4 }
      resource "local_file" "copy" {
        path = "${path.join(dir, 'copy.txt')}"
        content = random_string.r.id
      }
    `;
    const engine = newOrchestrator();

    await run(engine, await engine.plan(config));

    expect(await fs.readFile(path.join(dir, 'copy.txt'), 'utf8')).toHaveLength(4);
  });
});
