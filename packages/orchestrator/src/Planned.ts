import { isUnknown } from '@clay/planner';

/**
 * What a plan knows of each instance it will create or change, by address: the values its configuration sets and knows.
 * The rest, and the id, only the apply makes. An apply reads state, so it is cleared before one.
 */
export class Planned {
  private attributes = new Map<string, Record<string, unknown>>();

  clear(): void {
    this.attributes.clear();
  }

  set(address: string, attributes: Record<string, unknown>): void {
    this.attributes.set(address, Object.fromEntries(Object.entries(attributes).filter(([, value]) => !isUnknown(value))));
  }

  get(address: string): Record<string, unknown> | undefined {
    return this.attributes.get(address);
  }
}
