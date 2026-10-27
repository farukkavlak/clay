import { AttributePath, EVERY_ITEM, isMarker } from '@clay/contracts';

/** Steps to match, and the text the step after them must equal. */
export type Pattern = [AttributePath, string];

interface Group {
  wild: number[];
  patterns: Pattern[];
}

export const everyItemPlaces = (steps: AttributePath) => [...steps.keys()].filter((at) => steps[at] === EVERY_ITEM);

/** A marker meets only itself; a key or index meets any spelled alike. */
function spelled(step: string | number): string {
  return isMarker(step) ? `marker ${step}` : `key ${String(step)}`;
}

function keyOf(steps: AttributePath, wild: ReadonlySet<number>, tail: string): string {
  return JSON.stringify([...steps.map((step, at) => (wild.has(at) ? '*' : spelled(step))), tail]);
}

/**
 * Patterns of steps, where a step every item, in a pattern or in the steps asked for, meets any step.
 * Patterns are grouped by where they have a step every item, and a group is keyed once for each set of places asked for with one,
 * so steps asked for are looked up, not held against every pattern.
 */
export class Patterns {
  private readonly groups = new Map<string, Group>();
  private readonly keyed = new Map<string, Set<string>>();

  constructor(patterns: readonly Pattern[]) {
    for (const [steps, tail] of patterns) {
      const wild = everyItemPlaces(steps);
      const group = this.groups.get(String(wild)) ?? { wild, patterns: [] };
      group.patterns.push([steps, tail]);
      this.groups.set(String(wild), group);
    }
  }

  /** Whether a pattern of as many steps meets `steps`, and its tail is `tail`. */
  has(steps: AttributePath, tail: string): boolean {
    const asked = everyItemPlaces(steps);

    return [...this.groups.values()].some((group) => this.keysOf(group, asked).has(keyOf(steps, new Set([...group.wild, ...asked]), tail)));
  }

  private keysOf(group: Group, asked: number[]): Set<string> {
    const id = `${String(group.wild)} ${String(asked)}`;
    const found = this.keyed.get(id);
    if (found !== undefined) return found;

    const wild = new Set([...group.wild, ...asked]);
    const keys = new Set(group.patterns.map(([steps, tail]) => keyOf(steps, wild, tail)));
    this.keyed.set(id, keys);
    return keys;
  }
}
