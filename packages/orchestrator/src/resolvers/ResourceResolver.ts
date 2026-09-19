import { IState } from '@miniform/state';

import { Address } from '../Address';
import { ScopeManager } from '../scope/ScopeManager';
import { IResolver } from './IResolver';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

export class ResourceResolver implements IResolver {
  constructor(private scopeManager: ScopeManager) {}

  resolve(pathParts: string[], context: Address, state: IState): unknown {
    if (pathParts.length < 3) throw new Error(`Resource reference must include attribute: ${pathParts.join('.')}`);

    const address = this.parseResourceAddress(pathParts.slice(0, -1), context);
    const resourceKey = address.toString();
    const resource = state.resources[resourceKey];

    if (!resource) throw new UnresolvedReferenceError(`Invalid resource reference "${pathParts.join('.')}": Resource "${resourceKey}" not found in state`);

    const attributeName = pathParts.at(-1)!;
    return this.getResolvedAttribute(resource, attributeName, pathParts.join('.'));
  }

  private parseResourceAddress(addressParts: string[], context?: Address): Address {
    if (addressParts[0] === 'module') return Address.parse(addressParts.join('.'));
    return new Address(context ? context.modulePath : [], addressParts[0], addressParts[1]);
  }

  private getResolvedAttribute(resource: { id?: string; attributes: Record<string, unknown> }, attributeName: string, fullPath: string): unknown {
    let attrValue: unknown = resource.attributes[attributeName];
    if (attrValue === undefined && attributeName === 'id') attrValue = resource.id;

    if (attrValue === undefined) throw new UnresolvedReferenceError(`Invalid resource reference "${fullPath}": Attribute "${attributeName}" not found on resource`);

    if (attrValue && typeof attrValue === 'object' && 'type' in attrValue && 'value' in attrValue) return (attrValue as { value: unknown }).value;

    return attrValue;
  }
}
