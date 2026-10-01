import { PlannedChange, planFromSchema, PlanRequest, ResourceHandler, Schema } from '@clay/contracts';
import crypto from 'node:crypto';

import { idOf } from './idOf';

export class NullResource implements ResourceHandler {
  async getSchema(): Promise<Schema> {
    return {
      id: { type: 'string', computed: true, kept: true },
      triggers: { type: 'map', elemType: 'string', required: false },
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

  async create(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { ...inputs, id: crypto.randomUUID() };
  }

  async update(prior: Record<string, unknown>, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { ...inputs, id: idOf(prior) };
  }

  async delete(_prior: Record<string, unknown>): Promise<void> {}
}
