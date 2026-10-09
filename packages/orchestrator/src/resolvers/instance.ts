import { InstanceKey, Schema, Type, types } from '@clay/contracts';
import { ModuleOutputReference, NAME, Position, spellReference, spellSteps, Step, stepKey } from '@clay/parser';

import { Repetition } from '../Instances';
import { placed } from '../place';

/** With no attribute, the whole instance is read; with `every`, every instance its count or for_each makes. */
export interface InstanceRead {
  every?: Repetition;
  key?: InstanceKey;
  attribute?: string;
  path: Step[];
}

export const COUNT_INDEX_OUTSIDE = 'count.index is only known inside a resource or a module call that has count';

export function eachOutside(name: 'key' | 'value'): string {
  return `each.${name} is only known inside a resource or a module call that has for_each`;
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
  const first = instanceKeyIn(path);
  const rest = path.slice(1);

  if (repetition === undefined) {
    if (typeof first === 'number') refuse(`${block} has no count, so it takes no index`, position);
    return { attribute: readAttribute(block, path, path, position), path: rest };
  }

  if (path.length === 0) return { every: repetition, path: [] };

  // The step is not echoed: it may be an attribute, or a key meant as the index.
  if (repetition === 'count' && typeof first !== 'number') refuse(`${block} has count, so name one of it by index, as in ${block}[0]`, position);
  if (repetition === 'for_each' && typeof first !== 'string') refuse(`${block} has for_each, so name one of it by key, as in ${block}["key"]`, position);

  return { key: first, attribute: readAttribute(block, path, rest, position), path: rest.slice(1) };
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
  const call = spellReference([{ name: 'module' }, { name: reference.module }]);
  const first = instanceKeyIn(reference.path);
  const rest = reference.path.slice(1);

  if (repetition === undefined) {
    if (typeof first === 'number') refuse(`${call} has no count, so it takes no index`, position);
    return { output: readOutput(reference, reference.path, position), path: rest };
  }

  if (reference.path.length === 0) return { every: repetition, path: [] };

  if (repetition === 'count' && typeof first !== 'number') refuse(`${call} has count, so name one of it by index, as in ${call}[0]`, position);
  if (repetition === 'for_each' && typeof first !== 'string') refuse(`${call} has for_each, so name one of it by key, as in ${call}["key"]`, position);

  return { key: first, output: readOutput(reference, rest, position), path: rest.slice(1) };
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
