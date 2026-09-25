import { ExactNumber, ResourceHandler, Schema } from '@clay/contracts';
import crypto from 'node:crypto';

const LENGTH_REQUIRED = 'random_string requires "length" attribute (number > 0)';

/** A number reaches a provider exactly; a length has to be a whole one a JavaScript array can be made with. */
function lengthOf(inputs: Record<string, unknown>): number {
  const { length } = inputs;
  if (!(length instanceof ExactNumber)) throw new Error(LENGTH_REQUIRED);

  const value = length.toSafeInteger('random_string "length"');
  if (value <= 0) throw new Error(LENGTH_REQUIRED);

  return value;
}

export class RandomStringResource implements ResourceHandler {
  async getSchema(): Promise<Schema> {
    return {
      length: { type: 'number', required: true, forceNew: true },
      special: { type: 'boolean', required: false, forceNew: true },
    };
  }

  async validate(inputs: Record<string, unknown>): Promise<void> {
    lengthOf(inputs);

    if (inputs.special !== undefined && typeof inputs.special !== 'boolean') throw new Error('random_string "special" attribute must be a boolean');
  }

  async create(inputs: Record<string, unknown>): Promise<string> {
    const length = lengthOf(inputs);
    const useSpecial = (inputs.special as boolean) ?? false;

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
    // The value is the id, so changed inputs mean a replacement, not an update.
  }

  async delete(_id: string): Promise<void> {}

  async read(_inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {};
  }
}
