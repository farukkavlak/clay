import { isRecord } from '@clay/contracts';

/** A class of its own, so a set stays one through variables and outputs, where no schema says what it is. */
export class SetValue {
  constructor(readonly members: readonly unknown[]) {}
}

/** The value as a provider, a plan or a state holds it: each set a list of its members. */
export function plain(value: unknown): unknown {
  if (value instanceof SetValue) return value.members.map((member) => plain(member));
  if (Array.isArray(value)) return value.map((item) => plain(item));
  if (!isRecord(value)) return value;

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
}
