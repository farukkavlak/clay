import { ExactNumber, PlannedChange, planFromSchema, PlanRequest, ResourceHandler, Schema } from '@clay/contracts';
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
      result: { type: 'string', computed: true },
    };
  }

  async validate(inputs: Record<string, unknown>): Promise<void> {
    lengthOf(inputs);

    if (inputs.special !== undefined && typeof inputs.special !== 'boolean') throw new Error('random_string "special" attribute must be a boolean');
  }

  async plan(request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(), request);
  }

  // Nothing outside the state holds it, so it is as it was applied.
  async read(_id: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(inputs: Record<string, unknown>): Promise<{ id: string; attributes: Record<string, unknown> }> {
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

    return { id: result, attributes: { ...inputs, result } };
  }

  // The value is the id, so changed inputs mean a replacement, not an update.
  async update(id: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { ...inputs, result: id };
  }

  async delete(_id: string): Promise<void> {}
}
