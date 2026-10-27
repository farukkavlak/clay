import { CreateRequest, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types } from '@clay/contracts';

const SCHEMA: Schema = {
  name: { type: types.string, required: true },
  note: { type: types.string, optional: true },
  mode: { type: types.string, optional: true },
};

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Takes a moment for each call it is told to, create and delete unless told others, and counts how many it has going at once. */
export class Slow implements Provider {
  readonly resources = ['slow'];
  readonly dataSources = [];
  running = 0;
  most = 0;
  reads = 0;

  constructor(private readonly slow: readonly string[] = ['create', 'delete']) {}

  private async working(call: string): Promise<void> {
    if (!this.slow.includes(call)) return;
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
    this.reads += 1;
    if (prior.mode === 'unread') throw new Error(`${String(prior.name)} cannot be read`);
    await this.working('read');
    if (prior.mode === 'unread late') throw new Error(`${String(prior.name)} cannot be read`);
    return prior;
  }

  async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    if (config.mode === 'fails') throw new Error(`${String(config.name)} cannot be made`);

    await this.working('create');
    return { ...config };
  }

  async update(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...config };
  }

  async delete(): Promise<void> {
    await this.working('delete');
  }

  async getDataSourceSchema(): Promise<Schema> {
    return {};
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(): Promise<Record<string, unknown>> {
    return {};
  }
}
