import { CreateRequest, PlannedChange, planFromSchema, PlanRequest, ResourceHandler, Schema, UpdateRequest } from '@clay/contracts';
import crypto from 'node:crypto';

export class NullResource implements ResourceHandler {
  async getSchema(): Promise<Schema> {
    return {
      id: { type: 'string', computed: true, kept: true },
      // A trigger is any value whose change matters, and Clay turns no number or bool into a string.
      triggers: { type: 'map', required: false },
    };
  }

  async validate(_inputs: Record<string, unknown>): Promise<void> {}

  async plan(request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(), request);
  }

  // Nothing outside the state holds it, so it is as it was applied.
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
