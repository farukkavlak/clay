import { isUnknown, sensitiveUnder, Type, typeAt } from '@clay/contracts';
import { ConfigError, Position, spellSteps, Step, stepKey } from '@clay/parser';

import { article, child, isAllSensitive, Value } from '../Value';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

/** What no value of this kind answers to, whatever it holds. Undefined when the kind can take the step. */
function wrongStep(kind: Type['kind'], step: string | number): string | undefined {
  // Members are stored sorted, so an index would shift whenever another member is added.
  if (kind === 'set') return typeof step === 'string' ? `is a set and has no key ${JSON.stringify(step)}` : `is a set and has no item [${step}]: its members have no order`;
  if (kind === 'list' || kind === 'tuple') return typeof step === 'string' ? `is ${article(kind)} and has no key ${JSON.stringify(step)}` : undefined;
  if (kind === 'map' || kind === 'object') return typeof step === 'number' ? `is ${article(kind)} and has no item [${step}]` : undefined;

  return `is ${article(kind)} and cannot be read into`;
}

/** Undefined when the step finds something. */
function missingItem(value: Value, step: number): string | undefined {
  const items = (value.data as unknown[]).length;
  if (step < items) return undefined;

  // How many a list sensitive as a whole holds is sensitive too.
  return isAllSensitive(value) ? `has no item [${step}]` : `has no item [${step}]: it holds ${items}`;
}

/** Undefined when the step finds something. */
function missing(value: Value, step: string | number): string | undefined {
  if (value.data === null) return 'is null and cannot be read into';

  const { kind } = value.type;
  const wrong = wrongStep(kind, step);
  if (wrong) return wrong;

  if (kind === 'list' || kind === 'tuple') return missingItem(value, step as number);
  // Plain indexing would find inherited names like `toString`.
  return Object.hasOwn(value.data as object, step) ? undefined : `has no key ${JSON.stringify(step)}`;
}

/** Undefined when the type can take the step, or does not say. */
function missingIn(type: Type, step: string | number): string | undefined {
  if (type.kind === 'dynamic') return undefined;

  const wrong = wrongStep(type.kind, step);
  if (wrong) return wrong;
  if (type.kind === 'tuple') return (step as number) < type.elements.length ? undefined : `has no item [${step}]`;
  if (type.kind === 'object') return Object.hasOwn(type.attributes, step) ? undefined : `has no key ${JSON.stringify(step)}`;

  return undefined;
}

export function typeInto(type: Type, steps: Step[]): Type {
  return steps.reduce((found, step) => typeAt(found, stepKey(step)), type);
}

/** An unknown of the type the remaining steps find, so the reader can still check it, and as sensitive as the part they reach. */
export function laterAt(value: Value, message: string, rest: Step[]): UnresolvedReferenceError {
  const sensitive = rest.reduce((paths, step) => sensitiveUnder(paths, stepKey(step)), [...(value.sensitive ?? [])]);

  return new UnresolvedReferenceError(message, typeInto(value.type, rest), sensitive);
}

/** Waits for the apply, but not before the type has refused every step it can: a string has no key, whatever it turns out to be. */
function checkKnown(value: Value, read: string, rest: Step[], position: Position): void {
  if (!isUnknown(value.data)) return;

  let found = value.type;
  for (const [i, step] of rest.entries()) {
    const problem = missingIn(found, stepKey(step));
    if (problem) throw new ConfigError(`${read}${spellSteps(rest.slice(0, i))} ${problem}`, position);

    found = typeAt(found, stepKey(step));
  }

  throw laterAt(value, `${read} is known only after apply`, rest);
}

/**
 * A step that finds nothing is a configuration error, not a value to come, so it is refused at the reference.
 * Reading an unknown part, or into one, gives unknown. `target` names the value for messages.
 */
export function readPath(value: Value, target: string, path: Step[], position: Position): Value {
  let current = value;

  for (const [i, step] of path.entries()) {
    const read = `${target}${spellSteps(path.slice(0, i))}`;
    checkKnown(current, read, path.slice(i), position);

    const problem = missing(current, stepKey(step));
    if (problem) throw new ConfigError(`${read} ${problem}`, position);

    current = child(current, stepKey(step));
  }

  checkKnown(current, `${target}${spellSteps(path)}`, [], position);
  return current;
}
