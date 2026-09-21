import { Address, State } from '@clay/contracts';
import { Resolver } from './Resolver';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

export class ResourceResolver implements Resolver {
  resolve(pathParts: string[], context: Address, state: State): unknown {
    if (pathParts.length < 3) throw new Error(`Resource reference must include attribute: ${pathParts.join('.')}`);

    const resourceKey = new Address(context.modulePath, pathParts[0], pathParts[1]).toString();
    const resource = state.resources[resourceKey];

    if (!resource) throw new UnresolvedReferenceError(`Invalid resource reference "${pathParts.join('.')}": Resource "${resourceKey}" not found in state`);

    const attributeName = pathParts.at(-1)!;
    return this.getResolvedAttribute(resource, attributeName, pathParts.join('.'));
  }

  private getResolvedAttribute(resource: { id?: string; attributes: Record<string, unknown> }, attributeName: string, fullPath: string): unknown {
    let attrValue: unknown = resource.attributes[attributeName];
    if (attrValue === undefined && attributeName === 'id') attrValue = resource.id;

    if (attrValue === undefined) throw new UnresolvedReferenceError(`Invalid resource reference "${fullPath}": Attribute "${attributeName}" not found on resource`);

    return attrValue;
  }
}
