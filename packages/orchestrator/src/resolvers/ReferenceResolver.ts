import { Address, ExactNumber, State } from '@clay/contracts';
import { ConfigError, ParsedReference, parseReference, Position, ReferenceNode, spellReference, Step, TemplatePart } from '@clay/parser';

import { Instances } from '../Instances';
import { ScopeManager } from '../scope/ScopeManager';
import { DataSourceResolver } from './DataSourceResolver';
import { ModuleOutputResolver } from './ModuleOutputResolver';
import { kindOf, readPath } from './readPath';
import { ResourceResolver } from './ResourceResolver';
import { VariableResolver } from './VariableResolver';

/** The instance being made names its index; anything else read outside one has none. */
function countIndex(where: Address, position: Position): ExactNumber {
  if (typeof where.key !== 'number') throw new ConfigError('count.index is only known inside a resource that has count', position);

  return ExactNumber.parse(String(where.key));
}

export class ReferenceResolver {
  private variables: VariableResolver;
  private dataSources: DataSourceResolver;
  private moduleOutputs: ModuleOutputResolver;
  private resources: ResourceResolver;

  constructor(scopeManager: ScopeManager, dataSources: Map<string, Record<string, unknown>>, instances: Instances) {
    this.variables = new VariableResolver(scopeManager, this);
    this.dataSources = new DataSourceResolver(dataSources);
    this.moduleOutputs = new ModuleOutputResolver(scopeManager);
    this.resources = new ResourceResolver(instances);
  }

  private resolve(node: ReferenceNode, state: State, context?: Address): unknown {
    const { value, path } = this.resolveTarget(parseReference(node.value), state, context || new Address([], '', ''), node.position);
    const target = node.value.slice(0, node.value.length - path.length);

    return readPath(value, target, path, node.position);
  }

  /** What the reference names, and the steps still to take into it. */
  private resolveTarget(reference: ParsedReference, state: State, where: Address, position: Position): { value: unknown; path: Step[] } {
    if (reference.kind === 'variable') return { value: this.variables.resolve(reference, where, state), path: reference.path };
    if (reference.kind === 'data') return { value: this.dataSources.resolve(reference, where), path: reference.path };
    if (reference.kind === 'module') return { value: this.moduleOutputs.resolve(reference, where), path: reference.path };
    if (reference.kind === 'count') return { value: countIndex(where, position), path: reference.path };

    return this.resources.resolve(reference, where, state, position);
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
        return this.resolve(node as ReferenceNode, state, context);
      }
      case 'Template': {
        return this.resolveTemplate(node.value as TemplatePart[], state, context);
      }
      case 'List': {
        return this.resolveList(node, state, context);
      }
      case 'Map': {
        return this.resolveMap(node, state, context);
      }
      case 'String':
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

  /** A template that is one interpolation is the value itself, type and all; text around it makes it a string. */
  private resolveTemplate(parts: TemplatePart[], state: State, context?: Address): unknown {
    const [first] = parts;
    if (parts.length === 1 && typeof first !== 'string') return this.resolve(first, state, context);

    return parts.map((part) => (typeof part === 'string' ? part : this.joined(part, state, context))).join('');
  }

  private joined(reference: ReferenceNode, state: State, context?: Address): string {
    const resolved = this.resolve(reference, state, context);
    const kind = kindOf(resolved);
    if (kind === 'list' || kind === 'map') throw new ConfigError(`${spellReference(reference.value)} is a ${kind} and cannot be joined into a string`, reference.position);

    return String(resolved);
  }
}
