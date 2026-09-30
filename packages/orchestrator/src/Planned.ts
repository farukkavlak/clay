import { isUnknown, Schema } from '@clay/contracts';

/** An instance as the plan knows it: the values its configuration sets and knows, and the names only the apply will give a value. */
export interface PlannedInstance {
  known: Record<string, unknown>;
  later: Set<string>;
}

/**
 * What a plan knows of each instance it will create or change, by address.
 * The id, what the provider computes, and what the configuration sets but does not know yet, only the apply makes. An apply reads state, so it is cleared before one.
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

  set(address: string, attributes: Record<string, unknown>, schema: Schema | undefined): void {
    const entries = Object.entries(attributes);
    const computed = Object.entries(schema ?? {})
      .filter(([, definition]) => definition.computed)
      .map(([name]) => name);
    const unknown = entries.filter(([, value]) => isUnknown(value)).map(([name]) => name);

    this.instances.set(address, {
      known: Object.fromEntries(entries.filter(([, value]) => !isUnknown(value))),
      later: new Set(['id', ...computed, ...unknown]),
    });
  }

  get(address: string): PlannedInstance | undefined {
    return this.instances.get(address);
  }
}
