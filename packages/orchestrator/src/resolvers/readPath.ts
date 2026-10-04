import { isUnknown, Type, typeAt } from '@clay/contracts';
import { ConfigError, Position, spellSteps, Step } from '@clay/parser';

import { child, described, Value } from '../Value';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

/** Why `step` finds nothing in a list or a tuple, or nothing when it finds something. */
function missingItem(value: Value, step: Step): string | undefined {
  if (typeof step === 'string') return `is ${described(value)} and has no key ${JSON.stringify(step)}`;

  const items = (value.data as unknown[]).length;
  return step < items ? undefined : `has no item [${step}]: it holds ${items}`;
}

/** Why `step` finds nothing in `value`, or nothing when it finds something. */
function missing(value: Value, step: Step): string | undefined {
  if (value.data === null) return 'is null and cannot be read into';

  const { kind } = value.type;
  if (kind === 'list' || kind === 'tuple') return missingItem(value, step);

  // Its members are held sorted, so an index would read whichever sorts first, and another member would move it.
  if (kind === 'set') return typeof step === 'string' ? `is a set and has no key ${JSON.stringify(step)}` : `is a set and has no item [${step}]: its members have no order`;

  if (kind === 'map' || kind === 'object') {
    if (typeof step === 'number') return `is ${described(value)} and has no item [${step}]`;
    // Plain indexing would find inherited names like `toString`.
    return Object.hasOwn(value.data as object, step) ? undefined : `has no key ${JSON.stringify(step)}`;
  }

  return `is ${described(value)} and cannot be read into`;
}

/** The type the steps into a value of `type` find. */
export function typeInto(type: Type, steps: Step[]): Type {
  return steps.reduce((found, step) => typeAt(found, step), type);
}

/** A value not known yet is read as nothing yet, with the type the steps still to take will find, so what reads it can still check that much. */
function checkKnown(value: Value, read: string, rest: Step[]): void {
  if (!isUnknown(value.data)) return;

  throw new UnresolvedReferenceError(`${read} is known only after apply`, typeInto(value.type, rest));
}

/**
 * Reads each step into what the one before it found. A step that finds nothing is a mistake in the configuration, not a value to come, so it is refused where the reference is written.
 * A value known in part may hold what only an apply makes; reading that, or into it, reads nothing yet. `target` is what the value is, as it is written.
 */
export function readPath(value: Value, target: string, path: Step[], position: Position): Value {
  let current = value;

  for (const [i, step] of path.entries()) {
    const read = `${target}${spellSteps(path.slice(0, i))}`;
    checkKnown(current, read, path.slice(i));

    const problem = missing(current, step);
    if (problem) throw new ConfigError(`${read} ${problem}`, position);

    current = child(current, step);
  }

  checkKnown(current, `${target}${spellSteps(path)}`, []);
  return current;
}
