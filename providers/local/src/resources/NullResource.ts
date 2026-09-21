import { ResourceHandler, Schema } from '@clay/contracts';
import crypto from 'node:crypto';

export class NullResource implements ResourceHandler {
  async getSchema(): Promise<Schema> {
    return {
      triggers: { type: 'map', elemType: 'string', required: false },
    };
  }

  async validate(_inputs: Record<string, unknown>): Promise<void> {}

  async create(_inputs: Record<string, unknown>): Promise<string> {
    return crypto.randomUUID();
  }

  async update(_id: string, _inputs: Record<string, unknown>): Promise<void> {}

  async delete(_id: string): Promise<void> {}

  async read(_inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {};
  }
}
