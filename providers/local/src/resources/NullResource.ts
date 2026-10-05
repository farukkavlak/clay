import { CreateRequest, PlannedChange, planFromSchema, PlanRequest, ResourceHandler, Schema, types, UpdateRequest } from '@clay/contracts';
import crypto from 'node:crypto';

export class NullResource implements ResourceHandler {
  async getSchema(): Promise<Schema> {
    return {
      id: { type: types.string, computed: true, kept: true },
      // `dynamic`, since a trigger may be any value and Clay does not turn numbers or bools into strings.
      triggers: { type: types.map(types.dynamic), required: false },
    };
  }

  async validate(_inputs: Record<string, unknown>): Promise<void> {}

  async plan(request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(), request);
  }

  // It exists only in state, so it is as applied.
  async read(prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create({ planned }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...planned, id: crypto.randomUUID() };
  }

  async update({ planned }: UpdateRequest): Promise<Record<string, unknown>> {
    return planned;
  }

  async delete(_prior: Record<string, unknown>): Promise<void> {}
}
