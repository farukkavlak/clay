import { isUnknown } from '@clay/planner';

/**
 * What a plan knows of each instance it will create or change, by address: the values its configuration sets and knows.
 * The rest, and the id, only the apply makes. An apply reads state, so it is cleared before one.
 */
export class Planned {
  private attributes = new Map<string, Record<string, unknown>>();
  private planning = false;

  clear(): void {
    this.attributes.clear();
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

  set(address: string, attributes: Record<string, unknown>): void {
    this.attributes.set(address, Object.fromEntries(Object.entries(attributes).filter(([, value]) => !isUnknown(value))));
  }

  get(address: string): Record<string, unknown> | undefined {
    return this.attributes.get(address);
  }
}
