import { ExactNumber } from '@clay/contracts';
import { ConfigError, Position, spellReference, Step } from '@clay/parser';

/** What a value is, in the words the language uses for it. */
export function kindOf(value: unknown): string {
  if (Array.isArray(value)) return 'list';
  if (value instanceof ExactNumber || typeof value === 'number') return 'number';
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return 'map';

  return typeof value === 'boolean' ? 'bool' : 'string';
}

/** Why `step` finds nothing in `value`, or nothing when it finds something. */
function missing(value: unknown, step: Step): string | undefined {
  const kind = kindOf(value);

  if (kind === 'list') {
    if (typeof step === 'string') return `is a list and has no key ${JSON.stringify(step)}`;
    const items = (value as unknown[]).length;
    return step < items ? undefined : `has no item [${step}]: it holds ${items}`;
  }

  if (kind === 'map') {
    if (typeof step === 'number') return `is a map and has no item [${step}]`;
    // Plain indexing would find inherited names like `toString`.
    return Object.hasOwn(value as object, step) ? undefined : `has no key ${JSON.stringify(step)}`;
  }

  return kind === 'null' ? 'is null and cannot be read into' : `is a ${kind} and cannot be read into`;
}

/** Reads each step into what the one before it found. A step that finds nothing is a mistake in the configuration, not a value to come, so it is refused where the reference is written. */
export function readPath(value: unknown, target: Step[], path: Step[], position: Position): unknown {
  let current = value;

  for (const [i, step] of path.entries()) {
    const problem = missing(current, step);
    if (problem) throw new ConfigError(`${spellReference([...target, ...path.slice(0, i)])} ${problem}`, position);

    current = (current as Record<Step, unknown>)[step];
  }

  return current;
}
