import { emptyState } from '@clay/contracts';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryFiles, Orchestrator, RunEvent } from '../src/index';
import { engineOn } from './engine';

const config = `output "name" {
  value = "a"
}
`;

async function drain(events: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const seen: RunEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe('a plan and a run under a lock the caller holds', () => {
  let dir: string;
  let manager: StateManager;

  const lockPath = () => path.join(dir, 'clay.state.json.lock');
  const lockOperation = async () => (JSON.parse(await fs.readFile(lockPath(), 'utf8')) as { operation: string }).operation;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-held-lock-'));
    manager = new StateManager(new LocalBackend(dir));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('plans and runs under it, and leaves it to the caller to release', async () => {
    const engine = engineOn(manager);
    await manager.lock('apply');

    const plan = await engine.plan(config);
    const events = await drain(engine.runPlan(plan, config));

    expect(events.at(-1)?.type).toBe('done');
    expect(manager.held).toBe(true);
    expect(await lockOperation()).toBe('apply');
  });

  it('leaves it held when the run fails', async () => {
    const engine = engineOn(manager);
    await manager.lock('apply');
    const plan = await engine.plan(config);
    await manager.write(emptyState());

    await expect(drain(engine.runPlan(plan, config))).rejects.toThrow('The state has changed since the plan was made');
    expect(manager.held).toBe(true);
    expect(await lockOperation()).toBe('apply');
  });

  it('refuses a plan when the caller holds none, and takes none of its own', async () => {
    const engine = Orchestrator.create(manager, new InMemoryFiles({ 'main.clay': config }));

    await expect(engine.plan()).rejects.toThrow('A plan needs the state lock, and none is held');
    await expect(fs.access(lockPath())).rejects.toThrow(/ENOENT/);
  });

  it('refuses a run when the caller holds none, before it reads the state', async () => {
    const engine = Orchestrator.create(manager, new InMemoryFiles({ 'main.clay': config }));
    await manager.lock('plan');
    const plan = await engine.plan();
    await manager.unlock();
    const read = vi.spyOn(manager, 'read');

    await expect(drain(engine.runPlan(plan))).rejects.toThrow('A run needs the state lock, and none is held');
    expect(read).not.toHaveBeenCalled();
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });
});
