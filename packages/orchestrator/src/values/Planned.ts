import { Address, AttributePath, isUnknown } from '@clay/contracts';

import { Versions } from './Versions';

export interface PlannedInstance {
  known: Record<string, unknown>;
  later: Set<string>;
  sensitive: readonly AttributePath[];
  /** False where only which parts are sensitive changes, so a data source that reads it can still be read at plan. */
  changes: boolean;
}

/** Planned values by address, so a reference reads what the plan will make. An apply reads state, so it plans nothing. */
export class Planned {
  private instances = new Map<string, PlannedInstance>();
  private planning = false;

  constructor(private versions: Versions) {}

  /** While planning, an item only the apply knows is UNKNOWN and the rest of the value stays known. */
  begin(): void {
    this.planning = true;
  }

  /** An apply reads every value in full, so an unknown there is an error. */
  isPlanning(): boolean {
    return this.planning;
  }

  set(address: Address, after: Record<string, unknown>, sensitive: readonly AttributePath[], changes: boolean): void {
    const entries = Object.entries(after);
    const known = Object.fromEntries(entries.filter(([, value]) => !isUnknown(value)));
    const later = new Set(entries.filter(([, value]) => isUnknown(value)).map(([name]) => name));

    this.instances.set(address.toString(), { known, later, sensitive, changes });
    this.versions.changed(address.withoutKey().toString());
  }

  get(address: string): PlannedInstance | undefined {
    return this.instances.get(address);
  }
}
