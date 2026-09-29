import { InstanceKey } from '@clay/contracts';

/** How a block makes many instances: numbered by `count`, or keyed by `for_each`. */
export type Repetition = 'count' | 'for_each';

/** The repetition an instance key belongs to: an index to count, a string to for_each, and none to a block with neither. */
export function repetitionOfKey(key: InstanceKey | undefined): Repetition | undefined {
  if (key === undefined) return undefined;

  return typeof key === 'number' ? 'count' : 'for_each';
}

/**
 * Which resource blocks make many instances, by the block as the configuration writes it, and which keys each makes once its count or for_each is read.
 * The keys and the values are by the block in one instance of its module, since each instance of the module reads its own count or for_each.
 */
export class Instances {
  private repetitions = new Map<string, Repetition>();
  private keys = new Map<string, InstanceKey[]>();
  private values = new Map<string, Map<string, unknown>>();

  clear(): void {
    this.repetitions.clear();
    this.keys.clear();
    this.values.clear();
  }

  declare(block: string, repetition: Repetition): void {
    this.repetitions.set(block, repetition);
  }

  repetitionOf(block: string): Repetition | undefined {
    return this.repetitions.get(block);
  }

  setCount(block: string, count: number): void {
    const keys = Array.from({ length: count }, (_, index) => index);
    this.keys.set(block, keys);
  }

  /** The value each key gives its instance, read as `each.value`. */
  setEach(block: string, values: Map<string, unknown>): void {
    this.keys.set(block, [...values.keys()]);
    this.values.set(block, values);
  }

  /** Nothing until a plan reads the count or for_each. An apply reads only for_each, for each.value, and runs the instances its plan listed. */
  keysOf(block: string): InstanceKey[] | undefined {
    return this.keys.get(block);
  }

  /** A plan and an apply both read the for_each, and check the keys they run, before any instance reads its value. */
  eachValue(block: string, key: string): unknown {
    return this.values.get(block)?.get(key);
  }
}
