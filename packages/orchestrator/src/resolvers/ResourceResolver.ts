import { Address, Schema, State, UNKNOWN } from '@clay/contracts';
import { Position, ResourceReference, spellReference, Step } from '@clay/parser';

import { Instances } from '../Instances';
import { blockKey, Context, moduleOf } from '../keys';
import { placed } from '../place';
import { Planned, PlannedInstance } from '../Planned';
import { TypeMismatch, typedValues } from '../typed';
import { Value } from '../Value';
import { noAttribute, readInstance } from './instance';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

/** A name only the apply sets is unknown; any other unplanned name is null. Names outside the schema were refused earlier. */
function plannedAttribute(instance: PlannedInstance, name: string): unknown {
  if (Object.hasOwn(instance.known, name)) return instance.known[name];

  return instance.later.has(name) ? UNKNOWN : null;
}

export class ResourceResolver {
  constructor(
    private instances: Instances,
    private planned: Planned,
    private schemas: Map<string, Schema>
  ) {}

  /** Returns the attribute and the steps still to take into it. */
  resolve(reference: ResourceReference, context: Context, state: State, position?: Position): { value: Value; path: Step[] } {
    const schema = this.schemas.get(reference.type) ?? {};
    const { value, attribute, path } = this.read(reference, schema, context, state, position);

    try {
      return { value: typedValues(schema, { [attribute]: value })[attribute], path };
    } catch (error) {
      if (!(error instanceof TypeMismatch)) throw error;
      throw placed(`${reference.type}.${reference.name} holds what its schema does not: ${error.message}`, position);
    }
  }

  /** An instance the plan creates or changes is read from the plan, not state. */
  private read(reference: ResourceReference, schema: Schema, context: Context, state: State, position?: Position): { value: unknown; attribute: string; path: Step[] } {
    const module = moduleOf(context);
    const block = blockKey(new Address(module, reference.type, reference.name));
    const { key, attribute, path } = readInstance(reference, this.instances.repetitionOf(block), position);

    const resourceKey = new Address(module, reference.type, reference.name, key).toString();
    const resource = state.resources[resourceKey];

    const spelled = spellReference([reference.type, reference.name, ...(key === undefined ? [] : [key]), attribute]);
    const planned = this.planned.get(resourceKey);
    if (planned) return { value: plannedAttribute(planned, attribute), attribute, path };
    if (!resource) throw new UnresolvedReferenceError(`Invalid resource reference "${spelled}": Resource "${resourceKey}" not found in state`);

    return { value: this.getResolvedAttribute(resource, reference.type, schema, attribute, position), attribute, path };
  }

  /** A schema attribute missing from state is null; any other name is refused. */
  private getResolvedAttribute(resource: { attributes: Record<string, unknown> }, type: string, schema: Schema, attributeName: string, position?: Position): unknown {
    // Plain indexing would find inherited names like `toString`.
    if (Object.hasOwn(resource.attributes, attributeName)) return resource.attributes[attributeName];
    if (Object.hasOwn(schema, attributeName)) return null;

    throw placed(noAttribute(type, attributeName), position);
  }
}
