import { CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types } from '@clay/contracts';
import { DiskFiles, Orchestrator, RunEvent } from '@clay/orchestrator';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCHEMA: Schema = {
  name: { type: types.string, required: true },
};

interface Latch {
  open: () => void;
  opened: Promise<void>;
}

function latch(): Latch {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { open, opened };
}

const events = async (run: AsyncGenerator<RunEvent>): Promise<RunEvent[]> => {
  const seen: RunEvent[] = [];
  for await (const event of run) seen.push(event);
  return seen;
};

/** Holds the creation of "a" until it is let go, so a test can do something while a run is half way. */
class Gate implements Provider {
  readonly resources = ['gate'];
  readonly dataSources = ['gate_word'];
  readonly reached = latch();
  readonly released = latch();

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
    if (config.name === 'a') {
      this.reached.open();
      await this.released.opened;
    }

    return { ...config };
  }

  async update(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...config };
  }

  async delete(): Promise<void> {}

  async getDataSourceSchema(): Promise<Schema> {
    return SCHEMA;
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(_type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { ...inputs };
  }
}

const configWith = (word: string) =>
  `locals { word = "${word}" }
resource "gate" "a" {
  name = "a"
}
data "gate_word" "w" {
  name = "${word}"
}
resource "gate" "b" {
  name = "\${local.word}-\${gate.a.name}"
}
resource "gate" "c" {
  name = "\${data.gate_word.w.name}-\${gate.a.name}"
}
output "word" {
  value = local.word
}`;

describe('a plan made while another run is half way', () => {
  let dir: string;
  let provider: Gate;
  let engine: Orchestrator;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-concurrent-'));
    provider = new Gate();
    engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(provider);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('leaves the run with the values of its own configuration', async () => {
    const first = configWith('first');
    const running = events(engine.runPlan(await engine.plan(first), first));
    await provider.reached.opened;

    const second = await engine.plan(configWith('second'));
    provider.released.open();
    const seen = await running;

    expect(second.outputs.word.new?.value).toBe('second');
    expect(seen.filter((event) => event.type === 'failed')).toEqual([]);
    const { resources } = await new LocalBackend(dir).read();
    expect(resources['gate.b'].attributes).toEqual({ name: 'first-a' });
    expect(resources['gate.c'].attributes).toEqual({ name: 'first-a' });
  });
});
