import { IResourceHandler, ISchema } from '@clay/contracts';
import crypto from 'node:crypto';

export class RandomStringResource implements IResourceHandler {
  async getSchema(): Promise<ISchema> {
    return {
      length: { type: 'number', required: true, forceNew: true },
      special: { type: 'boolean', required: false, forceNew: true },
    };
  }

  async validate(inputs: Record<string, unknown>): Promise<void> {
    if (inputs.length === undefined || typeof inputs.length !== 'number' || inputs.length <= 0) throw new Error('random_string requires "length" attribute (number > 0)');

    if (inputs.special !== undefined && typeof inputs.special !== 'boolean') throw new Error('random_string "special" attribute must be a boolean');
  }

  async create(inputs: Record<string, unknown>): Promise<string> {
    const length = inputs.length as number;
    const useSpecial = (inputs.special as boolean) ?? false;

    // Character sets
    const alphanumeric = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const special = '!@#$%^&*()_+-=[]{}|;:,.<>?';

    let chars = alphanumeric;
    if (useSpecial) chars += special;

    let result = '';
    const array = new Uint32Array(length);
    crypto.getRandomValues(array);

    for (let i = 0; i < length; i++) result += chars[array[i] % chars.length];

    return result;
  }

  async update(_id: string, _inputs: Record<string, unknown>): Promise<void> {
    // RandomString is immutable. If inputs change (e.g., length), logic dictates
    // the resource should be recreated (Destroy -> Create) by the Orchestrator.
    // We cannot update the ID (which represents the value) in-place here.
  }

  async delete(_id: string): Promise<void> {
    // No-op
  }

  async read(_inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {};
  }
}
