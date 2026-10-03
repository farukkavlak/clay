import { CreateRequest, ExactNumber, isUnknown, PlannedChange, planFromSchema, PlanRequest, ResourceHandler, Schema, types, UpdateRequest } from '@clay/contracts';
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
      length: { type: types.number, required: true, forceNew: true },
      special: { type: types.bool, required: false, forceNew: true },
      id: { type: types.string, computed: true, kept: true },
      result: { type: types.string, computed: true, kept: true },
    };
  }

  async validate(inputs: Record<string, unknown>): Promise<void> {
    if (!isUnknown(inputs.length)) lengthOf(inputs);
  }

  async plan(request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(), request);
  }

  // Nothing outside the state holds it, so it is as it was applied.
  async read(prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create({ planned }: CreateRequest): Promise<Record<string, unknown>> {
    const length = lengthOf(planned);
    const useSpecial = (planned.special as boolean) ?? false;

    const alphanumeric = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const special = '!@#$%^&*()_+-=[]{}|;:,.<>?';

    let chars = alphanumeric;
    if (useSpecial) chars += special;

    let result = '';
    const array = new Uint32Array(length);
    crypto.getRandomValues(array);

    for (let i = 0; i < length; i++) result += chars[array[i] % chars.length];

    return { ...planned, id: result, result };
  }

  // The value is kept, so the plan already holds it.
  async update({ planned }: UpdateRequest): Promise<Record<string, unknown>> {
    return planned;
  }

  async delete(_prior: Record<string, unknown>): Promise<void> {}
}
