import { Address, State } from '@clay/contracts';
import { ScopeManager } from '../scope/ScopeManager';
import { DataSourceResolver } from './DataSourceResolver';
import { Resolver } from './Resolver';
import { ModuleOutputResolver } from './ModuleOutputResolver';
import { ResourceResolver } from './ResourceResolver';
import { VariableResolver } from './VariableResolver';

export class ReferenceResolver {
  private resolvers: Map<string, Resolver> = new Map();

  constructor(scopeManager: ScopeManager, dataSources: Map<string, Record<string, unknown>>) {
    this.resolvers.set('var', new VariableResolver(scopeManager, this));
    this.resolvers.set('data', new DataSourceResolver(dataSources));
    this.resolvers.set('module', new ModuleOutputResolver(scopeManager));
    this.resolvers.set('_resource', new ResourceResolver());
  }

  resolve(pathParts: string[], state: State, context?: Address): unknown {
    const refType = pathParts[0];
    const resolver = this.resolvers.get(refType);
    if (resolver) return resolver.resolve(pathParts, context || new Address([], '', ''), state);

    const resourceResolver = this.resolvers.get('_resource')!;
    return resourceResolver.resolve(pathParts, context || new Address([], '', ''), state);
  }

  resolveAttributes(attributes: Record<string, unknown>, state: State, context?: Address): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attributes)) resolved[key] = this.resolveValue(value, state, context);
    return resolved;
  }

  resolveValue(value: unknown, state: State, context?: Address): unknown {
    if (!value || typeof value !== 'object') return value;

    const node = value as { type?: string; value?: unknown };

    switch (node.type) {
      case 'Reference': {
        return this.resolve(node.value as string[], state, context);
      }
      case 'String': {
        return this.interpolateString(node.value as string, state, context);
      }
      case 'List': {
        return this.resolveList(node, state, context);
      }
      case 'Map': {
        return this.resolveMap(node, state, context);
      }
      case 'Number':
      case 'Boolean': {
        return node.value;
      }
      // A map whose keys are type and value is a value, not a node.
      default: {
        return value;
      }
    }
  }

  private resolveList(valueObj: { value?: unknown }, state: State, context?: Address): unknown[] {
    if (!Array.isArray(valueObj.value)) return [];
    return valueObj.value.map((item) => this.resolveValue(item, state, context));
  }

  private resolveMap(valueObj: { value?: unknown }, state: State, context?: Address): Record<string, unknown> {
    if (!valueObj.value || typeof valueObj.value !== 'object') return {};
    const map = valueObj.value as Record<string, unknown>;
    const resolvedMap: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(map)) resolvedMap[key] = this.resolveValue(val, state, context);

    return resolvedMap;
  }

  /** A string that is one interpolation is the value itself, type and all; text around it makes it a string. */
  interpolateString(value: string, state: State, context?: Address): unknown {
    const whole = value.match(/^\${([^}]+)}$/);
    if (whole) return this.resolve(whole[1].trim().split('.'), state, context);

    return value.replaceAll(/\${([^}]+)}/g, (_: string, expr: string) => {
      const resolved = this.resolve(expr.trim().split('.'), state, context);
      if (resolved !== null && typeof resolved === 'object')
        throw new Error(`"${value}" cannot be joined into a string: ${expr.trim()} is a ${Array.isArray(resolved) ? 'list' : 'map'}`);

      return String(resolved);
    });
  }
}
