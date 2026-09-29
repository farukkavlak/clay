import { InstanceKey } from '@clay/contracts';
import { ModuleOutputReference, NAME, Position, ResourceReference, spellReference, Step } from '@clay/parser';

import { Repetition } from '../Instances';
import { placed } from '../place';

/** What a reference to a resource reads: which of its instances, the attribute on it, and the steps into that. */
export interface InstanceRead {
  key?: InstanceKey;
  attribute: string;
  path: Step[];
}

/** `count.index` read where no instance is made by count. */
export const COUNT_INDEX_OUTSIDE = 'count.index is only known inside a resource or a module call that has count';

/** `each.key` or `each.value` read where no instance is made by for_each. */
export function eachOutside(name: 'key' | 'value'): string {
  return `each.${name} is only known inside a resource or a module call that has for_each`;
}

function refuse(message: string, position?: Position): never {
  throw placed(message, position);
}

function readAttribute(reference: ResourceReference, steps: Step[], position?: Position): string {
  const [attribute] = steps;
  const spelled = spellReference([reference.type, reference.name, ...reference.path]);

  if (attribute === undefined) refuse(`Resource reference must include attribute: ${spelled}`, position);
  if (typeof attribute === 'number') refuse(`Reference "${spelled}" has an index where it needs a name`, position);
  if (!NAME.test(attribute)) refuse(`Reference "${spelled}" has ${JSON.stringify(attribute)} where it needs a name`, position);

  return attribute;
}

/**
 * A resource with count or for_each is read one instance at a time, so its first step is an index or a key; one with neither has none.
 * `.name` and `["name"]` read the same, so under for_each `local_file.a.web.id` reads the instance "web".
 */
export function readInstance(reference: ResourceReference, repetition: Repetition | undefined, position?: Position): InstanceRead {
  const block = spellReference([reference.type, reference.name]);
  const [first, ...rest] = reference.path;

  if (repetition === undefined) {
    if (typeof first === 'number') refuse(`${block} has no count, so it takes no index`, position);
    return { attribute: readAttribute(reference, reference.path, position), path: rest };
  }

  // What follows is not shown back: it may be an attribute, or a key meant as the index.
  if (repetition === 'count' && typeof first !== 'number') refuse(`${block} has count, so name one of it by index, as in ${block}[0]`, position);
  if (repetition === 'for_each' && typeof first !== 'string') refuse(`${block} has for_each, so name one of it by key, as in ${block}["key"]`, position);
  // `local_file.a.content` reads "content" as the key, which a reader may have meant as the attribute.
  if (repetition === 'for_each' && rest.length === 0)
    refuse(
      `Reference "${spellReference([reference.type, reference.name, ...reference.path])}" names an instance and no attribute: ${block} has for_each, so its key comes first, as in ${block}["key"].id`,
      position
    );

  return { key: first, attribute: readAttribute(reference, rest, position), path: rest.slice(1) };
}

/** What a reference to a module reads: which of its instances, the output, and the steps into that. */
export interface CallRead {
  key?: InstanceKey;
  output: string;
  path: Step[];
}

function readOutput(reference: ModuleOutputReference, steps: Step[], position?: Position): string {
  const [output] = steps;
  const spelled = spellReference(['module', reference.module, ...reference.path]);

  if (output === undefined) refuse(`Module output reference must include output name: ${spelled}`, position);
  if (typeof output === 'number') refuse(`Reference "${spelled}" has an index where it needs a name`, position);
  if (!NAME.test(output)) refuse(`Reference "${spelled}" has ${JSON.stringify(output)} where it needs a name`, position);

  return output;
}

/**
 * A module called with count or for_each is read one instance at a time, so its first step is an index or a key; one called with neither has none.
 * `.name` and `["name"]` read the same, so under for_each `module.web.ali.url` reads the instance "ali".
 */
export function readCall(reference: ModuleOutputReference, repetition: Repetition | undefined, position?: Position): CallRead {
  const call = spellReference(['module', reference.module]);
  const [first, ...rest] = reference.path;

  if (repetition === undefined) {
    if (typeof first === 'number') refuse(`${call} has no count, so it takes no index`, position);
    return { output: readOutput(reference, reference.path, position), path: rest };
  }

  if (repetition === 'count' && typeof first !== 'number') refuse(`${call} has count, so name one of it by index, as in ${call}[0]`, position);
  if (repetition === 'for_each' && typeof first !== 'string') refuse(`${call} has for_each, so name one of it by key, as in ${call}["key"]`, position);
  // `module.web.url` reads "url" as the key, which a reader may have meant as the output.
  if (repetition === 'for_each' && rest.length === 0)
    refuse(
      `Reference "${spellReference(['module', reference.module, ...reference.path])}" names an instance and no output: ${call} has for_each, so its key comes first, as in ${call}["key"].out`,
      position
    );

  return { key: first, output: readOutput(reference, rest, position), path: rest.slice(1) };
}

/** An index past the count names an instance the plan will not make, so it is refused rather than read as one still to come. `block` is as written: `local_file.a`, `module.m`. */
export function checkInRange(block: string, key: number, count: number | undefined, position?: Position): void {
  if (count === undefined || key < count) return;

  if (count === 0) refuse(`${block} has no instances: its count is 0`, position);

  refuse(`${block} has ${count} ${count === 1 ? 'instance, [0]' : `instances, [0] to [${count - 1}]`}`, position);
}

/** A key for_each does not give names an instance the plan will not make, so it is refused rather than read as one still to come. */
export function checkHasKey(block: string, key: string, keys: InstanceKey[] | undefined, position?: Position): void {
  if (keys === undefined || keys.includes(key)) return;

  if (keys.length === 0) refuse(`${block} has no instances: its for_each is empty`, position);

  refuse(`${block} has no instance [${JSON.stringify(key)}], only ${keys.map((k) => `[${JSON.stringify(k)}]`).join(', ')}`, position);
}
