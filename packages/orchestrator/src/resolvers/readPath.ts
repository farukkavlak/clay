import { isUnknown, Type, typeAt } from '@clay/contracts';
import { ConfigError, Position, spellSteps, Step, stepKey } from '@clay/parser';

import { child, described, isAllSensitive, sensitiveUnder, Value } from '../Value';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

/** Undefined when the step finds something. */
function missingItem(value: Value, step: string | number): string | undefined {
  if (typeof step === 'string') return `is ${described(value)} and has no key ${JSON.stringify(step)}`;

  const items = (value.data as unknown[]).length;
  if (step < items) return undefined;

  // How many a list sensitive as a whole holds is sensitive too.
  return isAllSensitive(value) ? `has no item [${step}]` : `has no item [${step}]: it holds ${items}`;
}

/** Undefined when the step finds something. */
function missing(value: Value, step: string | number): string | undefined {
  if (value.data === null) return 'is null and cannot be read into';

  const { kind } = value.type;
  if (kind === 'list' || kind === 'tuple') return missingItem(value, step);

  // Members are stored sorted, so an index would shift whenever another member is added.
  if (kind === 'set') return typeof step === 'string' ? `is a set and has no key ${JSON.stringify(step)}` : `is a set and has no item [${step}]: its members have no order`;

  if (kind === 'map' || kind === 'object') {
    if (typeof step === 'number') return `is ${described(value)} and has no item [${step}]`;
    // Plain indexing would find inherited names like `toString`.
    return Object.hasOwn(value.data as object, step) ? undefined : `has no key ${JSON.stringify(step)}`;
  }

  return `is ${described(value)} and cannot be read into`;
}

export function typeInto(type: Type, steps: Step[]): Type {
  return steps.reduce((found, step) => typeAt(found, stepKey(step)), type);
}

/** An unknown of the type the remaining steps find, so the reader can still check it, and as sensitive as the part they reach. */
export function laterAt(value: Value, message: string, rest: Step[]): UnresolvedReferenceError {
  const sensitive = rest.reduce((paths, step) => sensitiveUnder(paths, stepKey(step)), [...(value.sensitive ?? [])]);

  return new UnresolvedReferenceError(message, typeInto(value.type, rest), sensitive);
}

function checkKnown(value: Value, read: string, rest: Step[]): void {
  if (isUnknown(value.data)) throw laterAt(value, `${read} is known only after apply`, rest);
}

/**
 * A step that finds nothing is a configuration error, not a value to come, so it is refused at the reference.
 * Reading an unknown part, or into one, gives unknown. `target` names the value for messages.
 */
export function readPath(value: Value, target: string, path: Step[], position: Position): Value {
  let current = value;

  for (const [i, step] of path.entries()) {
    const read = `${target}${spellSteps(path.slice(0, i))}`;
    checkKnown(current, read, path.slice(i));

    const problem = missing(current, stepKey(step));
    if (problem) throw new ConfigError(`${read} ${problem}`, position);

    current = child(current, stepKey(step));
  }

  checkKnown(current, `${target}${spellSteps(path)}`, []);
  return current;
}
