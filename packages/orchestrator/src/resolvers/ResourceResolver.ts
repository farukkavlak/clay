import { Address, State } from '@clay/contracts';
import { ResourceReference } from '@clay/parser';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

export class ResourceResolver {
  resolve(reference: ResourceReference, context: Address, state: State): unknown {
    const resourceKey = new Address(context.modulePath, reference.type, reference.name).toString();
    const resource = state.resources[resourceKey];

    const spelled = [reference.type, reference.name, ...reference.path].join('.');
    if (!resource) throw new UnresolvedReferenceError(`Invalid resource reference "${spelled}": Resource "${resourceKey}" not found in state`);

    // What lies between the name and the attribute is read by nobody yet.
    const [attribute] = reference.path.slice(-1);

    return this.getResolvedAttribute(resource, attribute, spelled);
  }

  private getResolvedAttribute(resource: { id?: string; attributes: Record<string, unknown> }, attributeName: string, fullPath: string): unknown {
    // Plain indexing would find inherited names like `toString`.
    let attrValue: unknown = Object.hasOwn(resource.attributes, attributeName) ? resource.attributes[attributeName] : undefined;
    if (attrValue === undefined && attributeName === 'id') attrValue = resource.id;

    if (attrValue === undefined) throw new UnresolvedReferenceError(`Invalid resource reference "${fullPath}": Attribute "${attributeName}" not found on resource`);

    return attrValue;
  }
}
