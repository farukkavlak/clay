import { CreateRequest, Identity, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types } from '@clay/contracts';

import { Signals } from '../../../../tests/signals';

const SCHEMA: Schema = {
  name: { type: types.string, required: true },
  note: { type: types.string, optional: true },
  mode: { type: types.string, optional: true },
  id: { type: types.string, computed: true },
};

const DATA_SCHEMA: Schema = { name: { type: types.string, required: true }, mode: { type: types.string, optional: true } };

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Takes a moment for each call it is told to, create and delete unless told others, and counts how many it has going at once.
 * An object whose `mode` is `<call> fails` fails that call at once, and `<call> fails late` after the others have had their moment.
 * One whose `mode` is `<call> after <name>` ends that call only once the same call for `<name>` has. A resource's `id` is its name, known once it is made.
 */
export class Slow implements Provider {
  readonly dataSources: string[];
  running = 0;
  most = 0;
  reads = 0;
  private readonly answered = new Signals();

  constructor(
    private readonly slow: readonly string[] = ['create', 'delete'],
    readonly resources: string[] = ['slow']
  ) {
    this.dataSources = resources;
  }

  private async answer(call: string, values: Record<string, unknown> = {}): Promise<void> {
    if (values.mode === `${call} fails`) throw new Error(`${String(values.name)} fails to ${call}`);

    if (this.slow.includes(call)) {
      this.running += 1;
      this.most = Math.max(this.most, this.running);
      await pause(30);
      this.running -= 1;
    }
    const after = typeof values.mode === 'string' && values.mode.startsWith(`${call} after `) ? values.mode.slice(`${call} after `.length) : undefined;
    if (after !== undefined) await this.answered.wait(`${call} ${after}`);
    this.answered.give(`${call} ${String(values.name)}`);

    if (values.mode !== `${call} fails late`) return;
    await pause(30);
    throw new Error(`${String(values.name)} fails to ${call}`);
  }

  async getSchema(): Promise<Schema> {
    await this.answer('getSchema');
    return SCHEMA;
  }

  async plan(_type: string, request: PlanRequest): Promise<PlannedChange> {
    await this.answer('plan', request.config);
    return planFromSchema(SCHEMA, request);
  }

  async validate(_type: string, config: Record<string, unknown>): Promise<void> {
    await this.answer('validate', config);
  }

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    this.reads += 1;
    await this.answer('read', prior);
    return prior;
  }

  async identify(_type: string, values: Record<string, unknown>): Promise<Identity | undefined> {
    await this.answer('identify', values);
    return undefined;
  }

  async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    await this.answer('create', config);
    return { ...config, id: config.name };
  }

  async update(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...config, id: config.name };
  }

  async delete(): Promise<void> {
    await this.answer('delete');
  }

  async getDataSourceSchema(type: string): Promise<Schema> {
    await this.answer('getDataSourceSchema', { name: type, mode: type.endsWith('_unloadable') ? 'getDataSourceSchema fails' : undefined });
    return DATA_SCHEMA;
  }

  async validateDataSource(_type: string, config: Record<string, unknown>): Promise<void> {
    await this.answer('validateDataSource', config);
  }

  async readDataSource(_type: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.answer('readDataSource', config);
    return config;
  }
}
