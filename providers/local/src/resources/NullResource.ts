import { ResourceHandler, Schema } from '@clay/contracts';
import crypto from 'node:crypto';

export class NullResource implements ResourceHandler {
  async getSchema(): Promise<Schema> {
    return {
      triggers: { type: 'map', elemType: 'string', required: false },
    };
  }

  async validate(_inputs: Record<string, unknown>): Promise<void> {}

  // Nothing outside the state holds it, so it is as it was applied.
  async read(_id: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(inputs: Record<string, unknown>): Promise<{ id: string; attributes: Record<string, unknown> }> {
    return { id: crypto.randomUUID(), attributes: inputs };
  }

  async update(_id: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return inputs;
  }

  async delete(_id: string): Promise<void> {}
}
