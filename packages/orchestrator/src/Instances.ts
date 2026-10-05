import { InstanceKey } from '@clay/contracts';

import { indexesOf } from './count';
import { Value } from './Value';

export type Repetition = 'count' | 'for_each';

export function repetitionOfKey(key: InstanceKey | undefined): Repetition | undefined {
  if (key === undefined) return undefined;

  return typeof key === 'number' ? 'count' : 'for_each';
}

/**
 * Repetition is stored per block, keys and values per block in one module instance, since each module instance reads its own count or for_each.
 */
export class Instances {
  private repetitions = new Map<string, Repetition>();
  private keys = new Map<string, InstanceKey[]>();
  private values = new Map<string, Map<string, Value>>();

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
    this.keys.set(block, indexesOf(count));
  }

  setEach(block: string, values: Map<string, Value>): void {
    this.keys.set(block, [...values.keys()]);
    this.values.set(block, values);
  }

  /** Undefined until count or for_each is read. */
  keysOf(block: string): InstanceKey[] | undefined {
    return this.keys.get(block);
  }

  /** Both plan and apply read for_each before any instance reads `each.value`. */
  eachValue(block: string, key: string): Value | undefined {
    return this.values.get(block)?.get(key);
  }
}
