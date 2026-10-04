import { Address, Schema, State, UNKNOWN } from '@clay/contracts';
import { Position, ResourceReference, spellReference, Step } from '@clay/parser';

import { Instances } from '../Instances';
import { blockKey, Context, moduleOf } from '../keys';
import { placed } from '../place';
import { Planned, PlannedInstance } from '../Planned';
import { TypeMismatch, typedValues } from '../typed';
import { Value } from '../Value';
import { readInstance } from './instance';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

/** What the provider computes, and a value the configuration does not know yet, only the apply makes. A name its schema has and nothing sets is null; any other never will be known. */
function plannedAttribute(instance: PlannedInstance, type: string, schema: Schema, name: string, spelled: string, position?: Position): unknown {
  if (Object.hasOwn(instance.known, name)) return instance.known[name];
  if (instance.later.has(name)) return UNKNOWN;
  if (Object.hasOwn(schema, name)) return null;

  throw placed(`"${spelled}" will never be known: the configuration does not set ${name} and ${type} does not compute it`, position);
}

export class ResourceResolver {
  constructor(
    private instances: Instances,
    private planned: Planned,
    private schemas: Map<string, Schema>
  ) {}

  /** The attribute the reference reads, as the type its schema names, and the steps still to take into it. */
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

  /** An instance the plan will create or change is read as the plan knows it. */
  private read(reference: ResourceReference, schema: Schema, context: Context, state: State, position?: Position): { value: unknown; attribute: string; path: Step[] } {
    const module = moduleOf(context);
    const block = blockKey(new Address(module, reference.type, reference.name));
    const { key, attribute, path } = readInstance(reference, this.instances.repetitionOf(block), position);

    const resourceKey = new Address(module, reference.type, reference.name, key).toString();
    const resource = state.resources[resourceKey];

    const spelled = spellReference([reference.type, reference.name, ...(key === undefined ? [] : [key]), attribute]);
    const planned = this.planned.get(resourceKey);
    if (planned) return { value: plannedAttribute(planned, reference.type, schema, attribute, spelled, position), attribute, path };
    if (!resource) throw new UnresolvedReferenceError(`Invalid resource reference "${spelled}": Resource "${resourceKey}" not found in state`);

    return { value: this.getResolvedAttribute(resource, schema, attribute, spelled, position), attribute, path };
  }

  /** State holds all a resource has, so a name its schema has and it does not hold was left out, and is null; any other never will be read. */
  private getResolvedAttribute(resource: { attributes: Record<string, unknown> }, schema: Schema, attributeName: string, fullPath: string, position?: Position): unknown {
    // Plain indexing would find inherited names like `toString`.
    if (Object.hasOwn(resource.attributes, attributeName)) return resource.attributes[attributeName];
    if (Object.hasOwn(schema, attributeName)) return null;

    throw placed(`Invalid resource reference "${fullPath}": Attribute "${attributeName}" not found on resource`, position);
  }
}
