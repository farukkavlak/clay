import { isUnknown } from '@clay/contracts';

export interface PlannedInstance {
  known: Record<string, unknown>;
  later: Set<string>;
}

/** Planned values by address, so a reference reads what the plan will make. Cleared before an apply, which reads state. */
export class Planned {
  private instances = new Map<string, PlannedInstance>();
  private planning = false;

  clear(): void {
    this.instances.clear();
    this.planning = false;
  }

  /** While planning, an item only the apply knows is UNKNOWN and the rest of the value stays known. */
  begin(): void {
    this.planning = true;
  }

  /** An apply reads every value in full, so an unknown there is an error. */
  isPlanning(): boolean {
    return this.planning;
  }

  set(address: string, after: Record<string, unknown>): void {
    const entries = Object.entries(after);
    const known = Object.fromEntries(entries.filter(([, value]) => !isUnknown(value)));
    const later = new Set(entries.filter(([, value]) => isUnknown(value)).map(([name]) => name));

    this.instances.set(address, { known, later });
  }

  get(address: string): PlannedInstance | undefined {
    return this.instances.get(address);
  }
}
