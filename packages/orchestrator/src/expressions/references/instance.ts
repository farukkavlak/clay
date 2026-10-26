import { InstanceKey, NAME, Schema, Type, types } from '@clay/contracts';
import { ModuleOutputReference, Position, spellReference, spellSteps, Step, stepKey } from '@clay/parser';

import { Repetition } from '../../instances/Instances';
import { placed } from '../../place';

/** With no attribute, the whole instance is read; with `every`, every instance its count or for_each makes. */
export interface InstanceRead {
  every?: Repetition;
  key?: InstanceKey;
  attribute?: string;
  path: Step[];
}

export const COUNT_INDEX_OUTSIDE = 'count.index is only known inside a resource, a data source or a module call that has count';

export function eachOutside(name: 'key' | 'value'): string {
  return `each.${name} is only known inside a resource, a data source or a module call that has for_each`;
}

export function noAttribute(type: string, name: string): string {
  return `${type} has no attribute "${name}"`;
}

function refuse(message: string, position?: Position): never {
  throw placed(message, position);
}

function firstKey(steps: Step[]): string | number | undefined {
  return steps.length === 0 ? undefined : stepKey(steps[0]);
}

/** An index or a key is written in brackets, so a name after a dot is never one. */
export function instanceKeyIn(steps: Step[]): InstanceKey | undefined {
  return steps.length > 0 && 'key' in steps[0] ? steps[0].key : undefined;
}

/** An index read from a value is a key once the instance reads it, so before that only the kind of block is checked. */
function fromValue(steps: Step[]): boolean {
  return steps.length > 0 && 'index' in steps[0];
}

/** A key is needed only where the block repeats; an index read from a value stands for one. */
function checkFirst(spelled: string, repetition: Repetition | undefined, path: Step[], position?: Position): void {
  const first = instanceKeyIn(path);
  const given = fromValue(path);

  if (repetition === undefined) {
    if (typeof first === 'number') refuse(`${spelled} has no count, so it takes no index`, position);
    if (given) refuse(`${spelled} has neither count nor for_each, so it takes no index`, position);
    return;
  }

  if (path.length === 0 || given) return;

  // The step is not echoed: it may be an attribute, or a key meant as the index.
  if (repetition === 'count' && typeof first !== 'number') refuse(`${spelled} has count, so name one of it by index, as in ${spelled}[0]`, position);
  if (repetition === 'for_each' && typeof first !== 'string') refuse(`${spelled} has for_each, so name one of it by key, as in ${spelled}["key"]`, position);
}

/** `written` is the whole path as the reference spells it after the block. */
function readAttribute(block: string, written: Step[], steps: Step[], position?: Position): string | undefined {
  const attribute = firstKey(steps);
  const spelled = `${block}${spellSteps(written)}`;

  if (attribute === undefined) return undefined;
  if (typeof attribute === 'number') refuse(`Reference "${spelled}" has an index where it needs a name`, position);
  if (!NAME.test(attribute)) refuse(`Reference "${spelled}" has ${JSON.stringify(attribute)} where it needs a name`, position);

  return attribute;
}

/**
 * With count or for_each the first step must be an index or a key in brackets, or there is no step at all; without either there is none.
 * A key after a dot would read `local_file.a.content` as the instance "content", so it is refused.
 */
export function readInstance(block: string, path: Step[], repetition: Repetition | undefined, position?: Position): InstanceRead {
  checkFirst(block, repetition, path, position);
  const rest = path.slice(1);

  if (repetition === undefined) return { attribute: readAttribute(block, path, path, position), path: rest };
  if (path.length === 0) return { every: repetition, path: [] };

  return { key: instanceKeyIn(path), attribute: readAttribute(block, path, rest, position), path: rest.slice(1) };
}

export function instanceType(schema: Schema): Type {
  return types.object(Object.fromEntries(Object.entries(schema).map(([name, attribute]) => [name, attribute.type])));
}

/** A list in index order under count, a map by key under for_each. */
export function everyOf(repetition: Repetition, instance: Type): Type {
  return repetition === 'count' ? types.list(instance) : types.map(instance);
}

/** Instances share the schema's type and a `dynamic` attribute takes each one's own, so a list or a map holds them all, where Terraform needs a tuple or an object. */
export function everyType(repetition: Repetition, schema: Schema): Type {
  return everyOf(repetition, instanceType(schema));
}

/** An output that names no type is `dynamic` until an instance gives it a value. */
export function outputsType(outputs: ReadonlyMap<string, Type>): Type {
  return types.object(Object.fromEntries(outputs));
}

/** With no output, the whole instance is read; with `every`, every instance its count or for_each makes. */
export interface CallRead {
  every?: Repetition;
  key?: InstanceKey;
  output?: string;
  path: Step[];
}

function readOutput(reference: ModuleOutputReference, steps: Step[], position?: Position): string | undefined {
  const output = firstKey(steps);
  const spelled = spellReference([{ name: 'module' }, { name: reference.module }, ...reference.path]);

  if (output === undefined) return undefined;
  if (typeof output === 'number') refuse(`Reference "${spelled}" has an index where it needs a name`, position);
  if (!NAME.test(output)) refuse(`Reference "${spelled}" has ${JSON.stringify(output)} where it needs a name`, position);

  return output;
}

/**
 * With count or for_each the first step must be an index or a key in brackets, or there is no step at all; without either there is none.
 * A key after a dot would read `module.web.url` as the instance "url", so it is refused.
 */
export function readCall(reference: ModuleOutputReference, repetition: Repetition | undefined, position?: Position): CallRead {
  checkFirst(spellReference([{ name: 'module' }, { name: reference.module }]), repetition, reference.path, position);
  const rest = reference.path.slice(1);

  if (repetition === undefined) return { output: readOutput(reference, reference.path, position), path: rest };
  if (reference.path.length === 0) return { every: repetition, path: [] };

  return { key: instanceKeyIn(reference.path), output: readOutput(reference, rest, position), path: rest.slice(1) };
}

/** Refused, since an instance that will never exist would otherwise read as unknown. */
export function checkInRange(block: string, key: number, count: number | undefined, position?: Position): void {
  if (count === undefined || key < count) return;

  if (count === 0) refuse(`${block} has no instances: its count is 0`, position);

  refuse(`${block} has ${count} ${count === 1 ? 'instance, [0]' : `instances, [0] to [${count - 1}]`}`, position);
}

/** Refused, since an instance that will never exist would otherwise read as unknown. */
export function checkHasKey(block: string, key: string, keys: InstanceKey[] | undefined, position?: Position): void {
  if (keys === undefined || keys.includes(key)) return;

  if (keys.length === 0) refuse(`${block} has no instances: its for_each is empty`, position);

  refuse(`${block} has no instance [${JSON.stringify(key)}], only ${keys.map((k) => `[${JSON.stringify(k)}]`).join(', ')}`, position);
}
