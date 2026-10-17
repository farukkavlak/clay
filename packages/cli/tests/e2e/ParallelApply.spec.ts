import { CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

const SCHEMA: Schema = {
  name: { type: types.string, required: true },
  note: { type: types.string, optional: true },
  mode: { type: types.string, optional: true },
};

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Takes a moment to create and delete, and counts how many it has going at once. */
class Slow implements Provider {
  readonly resources = ['slow'];
  readonly dataSources = [];
  running = 0;
  most = 0;

  private async working(): Promise<void> {
    this.running += 1;
    this.most = Math.max(this.most, this.running);
    await pause(30);
    this.running -= 1;
  }

  async getSchema(): Promise<Schema> {
    return SCHEMA;
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(SCHEMA, request);
  }

  async validate(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    if (config.mode === 'fails') throw new Error(`${String(config.name)} cannot be made`);

    await this.working();
    return { ...config };
  }

  async update(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...config };
  }

  async delete(): Promise<void> {
    await this.working();
  }

  async getDataSourceSchema(): Promise<Schema> {
    return {};
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(): Promise<Record<string, unknown>> {
    return {};
  }
}

const blocks = (...names: string[]) => names.map((name) => `resource "slow" "${name}" {\n  name = "${name}"\n}`).join('\n');

describe('a layer of resources', () => {
  let dir: string;
  let provider: Slow;
  let engine: Orchestrator;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-parallel-'));
    provider = new Slow();
    engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(provider);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const run = async (config: string): Promise<string[]> => {
    const events: string[] = [];
    for await (const event of start(engine, config))
      events.push(event.type === 'planned' || event.type === 'done' || event.type === 'read' ? event.type : `${event.type} ${event.action.name}`);

    return events;
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
