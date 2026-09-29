import { Address, State } from '@clay/contracts';
import { Position, ResourceReference, spellReference, Step } from '@clay/parser';

import { Instances } from '../Instances';
import { blockKey, Context, moduleOf } from '../keys';
import { Planned } from '../Planned';
import { readInstance } from './instance';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

/** A value the configuration does not set, or does not know yet, is one only the apply makes. */
function plannedAttribute(attributes: Record<string, unknown>, name: string, spelled: string): unknown {
  if (!Object.hasOwn(attributes, name)) throw new UnresolvedReferenceError(`"${spelled}" is known only after apply`);

  return attributes[name];
}

export class ResourceResolver {
  constructor(
    private instances: Instances,
    private planned: Planned
  ) {}

  /** The attribute the reference reads, and the steps still to take into it. An instance the plan will create or change is read as the plan knows it. */
  resolve(reference: ResourceReference, context: Context, state: State, position?: Position): { value: unknown; path: Step[] } {
    const module = moduleOf(context);
    const block = blockKey(new Address(module, reference.type, reference.name));
    const { key, attribute, path } = readInstance(reference, this.instances.repetitionOf(block), position);

    const resourceKey = new Address(module, reference.type, reference.name, key).toString();
    const resource = state.resources[resourceKey];

    const spelled = spellReference([reference.type, reference.name, ...(key === undefined ? [] : [key]), attribute]);
    const planned = this.planned.get(resourceKey);
    if (planned) return { value: plannedAttribute(planned, attribute, spelled), path };
    if (!resource) throw new UnresolvedReferenceError(`Invalid resource reference "${spelled}": Resource "${resourceKey}" not found in state`);

    return { value: this.getResolvedAttribute(resource, attribute, spelled), path };
  }

  private getResolvedAttribute(resource: { id?: string; attributes: Record<string, unknown> }, attributeName: string, fullPath: string): unknown {
    // Plain indexing would find inherited names like `toString`.
    let attrValue: unknown = Object.hasOwn(resource.attributes, attributeName) ? resource.attributes[attributeName] : undefined;
    if (attrValue === undefined && attributeName === 'id') attrValue = resource.id;

    if (attrValue === undefined) throw new UnresolvedReferenceError(`Invalid resource reference "${fullPath}": Attribute "${attributeName}" not found on resource`);

    return attrValue;
  }
}
