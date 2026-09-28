import { Address, State } from '@clay/contracts';
import { Position, ResourceReference, spellReference, Step } from '@clay/parser';

import { Instances } from '../Instances';
import { readInstance } from './instance';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

export class ResourceResolver {
  constructor(private instances: Instances) {}

  /** The attribute the reference reads, and the steps still to take into it. */
  resolve(reference: ResourceReference, context: Address, state: State, position?: Position): { value: unknown; path: Step[] } {
    const block = new Address(context.modulePath, reference.type, reference.name).toString();
    const { key, attribute, path } = readInstance(reference, this.instances.repetitionOf(block), position);

    const resourceKey = new Address(context.modulePath, reference.type, reference.name, key).toString();
    const resource = state.resources[resourceKey];

    const spelled = spellReference([reference.type, reference.name, ...(key === undefined ? [] : [key]), attribute]);
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
