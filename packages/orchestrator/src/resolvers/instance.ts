import { InstanceKey, Schema } from '@clay/contracts';
import { ModuleOutputReference, NAME, Position, ResourceReference, spellReference, Step, stepKey } from '@clay/parser';

import { Repetition } from '../Instances';
import { placed } from '../place';

/** With no attribute, the whole instance is read. */
export interface InstanceRead {
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

export function firstKey(steps: Step[]): string | number | undefined {
  return steps.length === 0 ? undefined : stepKey(steps[0]);
}

function readAttribute(reference: ResourceReference, steps: Step[], position?: Position): string | undefined {
  const attribute = firstKey(steps);
  const spelled = spellReference([{ name: reference.type }, { name: reference.name }, ...reference.path]);

  if (attribute === undefined) return undefined;
  if (typeof attribute === 'number') refuse(`Reference "${spelled}" has an index where it needs a name`, position);
  if (!NAME.test(attribute)) refuse(`Reference "${spelled}" has ${JSON.stringify(attribute)} where it needs a name`, position);

  return attribute;
}

/**
 * With count or for_each the first step must be an index or a key; without either there is none.
 * `.name` and `["name"]` are the same, so under for_each `local_file.a.web.id` reads the instance "web" and `local_file.a.content` the instance "content".
 */
export function readInstance(reference: ResourceReference, repetition: Repetition | undefined, position?: Position): InstanceRead {
  const block = spellReference([{ name: reference.type }, { name: reference.name }]);
  const first = firstKey(reference.path);
  const rest = reference.path.slice(1);

  if (repetition === undefined) {
    if (typeof first === 'number') refuse(`${block} has no count, so it takes no index`, position);
    return { attribute: readAttribute(reference, reference.path, position), path: rest };
  }

  // The step is not echoed: it may be an attribute, or a key meant as the index.
  if (repetition === 'count' && typeof first !== 'number') refuse(`${block} has count, so name one of it by index, as in ${block}[0]`, position);
  if (repetition === 'for_each' && typeof first !== 'string') refuse(`${block} has for_each, so name one of it by key, as in ${block}["key"]`, position);

  return { key: first, attribute: readAttribute(reference, rest, position), path: rest.slice(1) };
}

export interface CallRead {
  key?: InstanceKey;
  output: string;
  path: Step[];
}

function readOutput(reference: ModuleOutputReference, steps: Step[], position?: Position): string {
  const output = firstKey(steps);
  const spelled = spellReference([{ name: 'module' }, { name: reference.module }, ...reference.path]);

  if (output === undefined) refuse(`Module output reference must include output name: ${spelled}`, position);
  if (typeof output === 'number') refuse(`Reference "${spelled}" has an index where it needs a name`, position);
  if (!NAME.test(output)) refuse(`Reference "${spelled}" has ${JSON.stringify(output)} where it needs a name`, position);

  return output;
}

/**
 * With count or for_each the first step must be an index or a key; without either there is none.
 * `.name` and `["name"]` are the same, so under for_each `module.web.ali.url` reads the instance "ali".
 */
export function readCall(reference: ModuleOutputReference, repetition: Repetition | undefined, position?: Position): CallRead {
  const call = spellReference([{ name: 'module' }, { name: reference.module }]);
  const first = firstKey(reference.path);
  const rest = reference.path.slice(1);

  if (repetition === undefined) {
    if (typeof first === 'number') refuse(`${call} has no count, so it takes no index`, position);
    return { output: readOutput(reference, reference.path, position), path: rest };
  }

  if (repetition === 'count' && typeof first !== 'number') refuse(`${call} has count, so name one of it by index, as in ${call}[0]`, position);
  if (repetition === 'for_each' && typeof first !== 'string') refuse(`${call} has for_each, so name one of it by key, as in ${call}["key"]`, position);
  // `module.web.url` reads "url" as the key, though the author may have meant the output.
  if (repetition === 'for_each' && rest.length === 0)
    refuse(
      `Reference "${spellReference([{ name: 'module' }, { name: reference.module }, ...reference.path])}" names an instance and no output: ${call} has for_each, so its key comes first, as in ${call}["key"].out`,
      position
    );

  return { key: first, output: readOutput(reference, rest, position), path: rest.slice(1) };
}

/** Refused, since an instance that will never exist would otherwise read as unknown. */
export function checkInRange(block: string, key: number, count: number | undefined, position?: Position): void {
  if (count === undefined || key < count) return;

  if (count === 0) refuse(`${block} has no instances: its count is 0`, position);

  refuse(`${block} has ${count} ${count === 1 ? 'instance, [0]' : `instances, [0] to [${count - 1}]`}`, position);
}

/** A name after a dot that is an attribute: the author may have left the key out. */
export function keyComesFirst(block: string, type: string, step: Step, schema: Schema): string {
  if (!('name' in step) || !Object.hasOwn(schema, step.name)) return '';

  return `. "${step.name}" is an attribute of ${type}, and the key comes first, as in ${block}["key"].${step.name}`;
}

/** Refused, since an instance that will never exist would otherwise read as unknown. */
export function checkHasKey(block: string, key: string, keys: InstanceKey[] | undefined, position?: Position, hint = ''): void {
  if (keys === undefined || keys.includes(key)) return;

  if (keys.length === 0) refuse(`${block} has no instances: its for_each is empty`, position);

  refuse(`${block} has no instance [${JSON.stringify(key)}], only ${keys.map((k) => `[${JSON.stringify(k)}]`).join(', ')}${hint}`, position);
}
