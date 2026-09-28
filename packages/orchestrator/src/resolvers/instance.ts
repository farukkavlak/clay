import { InstanceKey } from '@clay/contracts';
import { NAME, Position, ResourceReference, spellReference, Step } from '@clay/parser';

import { Repetition } from '../Instances';
import { placed } from '../place';

/** What a reference to a resource reads: which of its instances, the attribute on it, and the steps into that. */
export interface InstanceRead {
  key?: InstanceKey;
  attribute: string;
  path: Step[];
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

/** An index past the count names an instance the plan will not make, so it is refused rather than read as one still to come. */
export function checkInRange(reference: ResourceReference, key: number, count: number | undefined, position?: Position): void {
  if (count === undefined || key < count) return;

  const block = spellReference([reference.type, reference.name]);
  if (count === 0) refuse(`${block} has no instances: its count is 0`, position);

  refuse(`${block} has ${count} ${count === 1 ? 'instance, [0]' : `instances, [0] to [${count - 1}]`}`, position);
}

/** A key for_each does not give names an instance the plan will not make, so it is refused rather than read as one still to come. */
export function checkHasKey(reference: ResourceReference, key: string, keys: InstanceKey[] | undefined, position?: Position): void {
  if (keys === undefined || keys.includes(key)) return;

  const block = spellReference([reference.type, reference.name]);
  if (keys.length === 0) refuse(`${block} has no instances: its for_each is empty`, position);

  refuse(`${block} has no instance [${JSON.stringify(key)}], only ${keys.map((k) => `[${JSON.stringify(k)}]`).join(', ')}`, position);
}
