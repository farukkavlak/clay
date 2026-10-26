import { AttributePath, isRecord, isUnknown, own, Resource, Schema } from '@clay/contracts';
import { Lifecycle } from '@clay/parser';

/** The prior holds nothing there. */
const GONE = Symbol('gone');

/** `all` leaves out what only the provider computes, which the configuration never carried. */
export function ignoredPaths(ignore: Lifecycle['ignoreChanges'], schema: Schema): AttributePath[] {
  if (ignore === undefined) return [];
  if (ignore !== 'all') return ignore.map(({ path }) => path);

  return Object.keys(schema)
    .filter((name) => !schema[name].computed || schema[name].optional)
    .map((name) => [name]);
}

function priorAt(value: unknown, path: AttributePath): unknown {
  let at = value;

  for (const step of path)
    if (Array.isArray(at) && typeof step === 'number' && step < at.length) at = at[step];
    else if (isRecord(at) && typeof step === 'string' && Object.hasOwn(at, step)) at = at[step];
    else return GONE;

  return at;
}

/** An index past the end adds the item, and one the prior has no item for drops it. */
function replacedItem(value: unknown, index: number, below: (item: unknown) => unknown): unknown {
  if (!Array.isArray(value)) return value;

  const next = below(value[index]);
  if (next === GONE) return value.filter((_, at) => at !== index);

  return index < value.length ? value.map((item, at) => (at === index ? next : item)) : [...value, next];
}

function replacedAt(value: unknown, path: AttributePath, prior: unknown): unknown {
  if (path.length === 0) return prior;

  const [step, ...rest] = path;
  const below = (item: unknown) => replacedAt(item, rest, prior);
  if (typeof step === 'number') return replacedItem(value, step, below);

  // A key of a value not known yet cannot be named, so the value stays whole.
  if (isUnknown(value)) return value;

  const record = isRecord(value) ? value : {};
  const next = below(own(record, step));
  if (next !== GONE) return { ...record, [step]: next };

  return isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([name]) => name !== step)) : value;
}

function within(marked: AttributePath, path: AttributePath): boolean {
  return path.length <= marked.length && path.every((step, at) => step === marked[at]);
}

/**
 * The configuration with each ignored path as the prior held it, or left out where the prior had none.
 * The marks go with the values: the prior's under an ignored path, the configuration's elsewhere.
 */
export function keepPrior(
  config: Record<string, unknown>,
  sensitive: AttributePath[],
  prior: Resource,
  paths: AttributePath[]
): { config: Record<string, unknown>; sensitive: AttributePath[] } {
  if (paths.length === 0) return { config, sensitive };

  let kept = config;
  for (const path of paths) kept = replacedAt(kept, path, priorAt(prior.attributes, path)) as Record<string, unknown>;

  const ignored = (marked: AttributePath) => paths.some((path) => within(marked, path));

  return { config: kept, sensitive: [...sensitive.filter((marked) => !ignored(marked)), ...(prior.sensitive ?? []).filter((marked) => ignored(marked))] };
}
