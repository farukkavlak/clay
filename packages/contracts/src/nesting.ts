import { isRecord } from './isRecord';
import { Type } from './Type';

/** Every walk over a value or a type recurses, so deeper nesting is refused where it enters, before one can overflow the stack. */
export const MAX_NESTING = 100;

/** Clay writes a value MAX_NESTING deep in about 205 levels, since an object type takes two each; 500 stays far below where the reviver overflows. */
export const MAX_FILE_NESTING = 500;

export class NestingError extends Error {
  override name = 'NestingError';

  constructor(readonly limit: number) {
    super(`it is nested more than ${limit} levels deep`);
  }
}

/** Walked with a stack of its own, since the levels may be more than the call stack holds. */
function deepestOf<T>(root: T, inner: (item: T) => readonly T[] | undefined): number {
  let deepest = 0;
  const pending: [T, number][] = [[root, 0]];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [item, levels] = next;
    const items = inner(item);
    if (items === undefined) continue;

    deepest = Math.max(deepest, levels + 1);
    for (const each of items) pending.push([each, levels + 1]);
  }

  return deepest;
}

/** Lists and plain records are levels; anything else is a leaf. */
export function nestingOf(value: unknown): number {
  return deepestOf(value, (item) => (Array.isArray(item) ? item : isRecord(item) ? Object.values(item) : undefined));
}

/** Each list, set, map, object and tuple is a level. */
export function typeNestingOf(type: Type): number {
  return deepestOf(type, (item) => {
    if (item.kind === 'list' || item.kind === 'set' || item.kind === 'map') return [item.element];
    if (item.kind === 'object') return Object.values(item.attributes);
    return item.kind === 'tuple' ? item.elements : undefined;
  });
}
