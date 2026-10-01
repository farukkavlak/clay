import { isUnknown } from '@clay/contracts';

/** An instance as the plan knows it: the values its provider planned and knows, and the names only the apply will give a value. */
export interface PlannedInstance {
  known: Record<string, unknown>;
  later: Set<string>;
}

/**
 * What a plan knows of each instance it will create or change, by address.
 * A value its provider planned as UNKNOWN, and an id no one knows yet, only the apply makes. An apply reads state, so it is cleared before one.
 */
export class Planned {
  private instances = new Map<string, PlannedInstance>();
  private planning = false;

  clear(): void {
    this.instances.clear();
    this.planning = false;
  }

  /** A plan is being made: an item of a list or a map that only an apply can read is UNKNOWN where it sits, and the rest of the value is known. */
  begin(): void {
    this.planning = true;
  }

  /** An apply reads every value in full, so a value it cannot read is an error there. */
  isPlanning(): boolean {
    return this.planning;
  }

  /** `id` is the id it keeps or the provider knows already; a resource that holds an `id` value of its own is read by that. */
  set(address: string, after: Record<string, unknown>, id: string | undefined): void {
    const entries = Object.entries(after);
    const known = Object.fromEntries(entries.filter(([, value]) => !isUnknown(value)));
    const later = new Set(entries.filter(([, value]) => isUnknown(value)).map(([name]) => name));
    const ownId = Object.hasOwn(after, 'id');

    if (!ownId && id === undefined) later.add('id');
    if (!ownId && id !== undefined) known.id = id;

    this.instances.set(address, { known, later });
  }

  get(address: string): PlannedInstance | undefined {
    return this.instances.get(address);
  }
}
