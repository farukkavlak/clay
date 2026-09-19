import { IResourceHandler, ISchema } from '@clay/contracts';
import crypto from 'node:crypto';

export class NullResource implements IResourceHandler {
  async getSchema(): Promise<ISchema> {
    return {
      triggers: { type: 'map', elemType: 'string', required: false },
    };
  }

  async validate(_inputs: Record<string, unknown>): Promise<void> {
    // Always valid
  }

  async create(_inputs: Record<string, unknown>): Promise<string> {
    return crypto.randomUUID();
  }

  async update(_id: string, _inputs: Record<string, unknown>): Promise<void> {
    // No-op
  }

  async delete(_id: string): Promise<void> {
    // No-op
  }

  async read(_inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {};
  }
}
