import { Address, ExactNumber, ModuleAddress, State } from '@clay/contracts';
import { UNKNOWN } from '@clay/planner';
import { ConfigError, EachReference, ParsedReference, parseReference, Position, ReferenceNode, spellReference, Step, TemplatePart } from '@clay/parser';

import { Instances } from '../Instances';
import { Context, instanceKeyOf, ModuleCall } from '../keys';
import { ModuleInstances } from '../ModuleInstances';
import { Planned } from '../Planned';
import { ScopeManager } from '../scope/ScopeManager';
import { DataSourceResolver } from './DataSourceResolver';
import { COUNT_INDEX_OUTSIDE, eachOutside } from './instance';
import { ModuleOutputResolver } from './ModuleOutputResolver';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';
import { kindOf, readPath } from './readPath';
import { ResourceResolver } from './ResourceResolver';
import { VariableResolver } from './VariableResolver';

/** The instance of a resource or of a module being made names its index; anything else read outside one has none. */
function countIndex(where: Context, position: Position): ExactNumber {
  const key = instanceKeyOf(where);
  if (typeof key !== 'number') throw new ConfigError(COUNT_INDEX_OUTSIDE, position);

  return ExactNumber.parse(String(key));
}

export class ReferenceResolver {
  private instances: Instances;
  private planned: Planned;
  private modules: ModuleInstances;
  private variables: VariableResolver;
  private dataSources: DataSourceResolver;
  private moduleOutputs: ModuleOutputResolver;
  private resources: ResourceResolver;

  constructor(scopeManager: ScopeManager, dataSources: Map<string, Record<string, unknown>>, instances: Instances, modules: ModuleInstances, planned: Planned) {
    this.instances = instances;
    this.planned = planned;
    this.modules = modules;
    this.variables = new VariableResolver(scopeManager, this);
    this.dataSources = new DataSourceResolver(dataSources);
    this.moduleOutputs = new ModuleOutputResolver(scopeManager, modules);
    this.resources = new ResourceResolver(instances, planned);
  }

  private resolve(node: ReferenceNode, state: State, context?: Context): unknown {
    const { value, path } = this.resolveTarget(parseReference(node.value), state, context ?? ModuleAddress.root, node.position);
    const target = node.value.slice(0, node.value.length - path.length);

    return readPath(value, target, path, node.position);
  }

  /** What the reference names, and the steps still to take into it. */
  private resolveTarget(reference: ParsedReference, state: State, where: Context, position: Position): { value: unknown; path: Step[] } {
    if (reference.kind === 'variable') return { value: this.variables.resolve(reference, where, state), path: reference.path };
    if (reference.kind === 'data') return { value: this.dataSources.resolve(reference, where), path: reference.path };
    if (reference.kind === 'module') return this.moduleOutputs.resolve(reference, where, position);
    if (reference.kind === 'count') return { value: countIndex(where, position), path: reference.path };
    if (reference.kind === 'each') return { value: this.each(reference, where, position), path: reference.path };

    return this.resources.resolve(reference, where, state, position);
  }

  /** The instance of a resource or of a module being made names its key, and the value for_each gives that key; anything else read outside one has neither. */
  private each(reference: EachReference, where: Context, position: Position): unknown {
    const key = instanceKeyOf(where);
    if (typeof key !== 'string') throw new ConfigError(eachOutside(reference.name), position);
    if (reference.name === 'key') return key;

    if (where instanceof ModuleCall) return this.modules.eachValue(where.call, key);

    // Only an instance of a resource or a module call has a key.
    return this.instances.eachValue((where as Address).withoutKey().toString(), key);
  }

  resolveAttributes(attributes: Record<string, unknown>, state: State, context?: Context): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attributes)) resolved[key] = this.resolveValue(value, state, context);
    return resolved;
  }

  resolveValue(value: unknown, state: State, context?: Context): unknown {
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

  private resolveList(valueObj: { value?: unknown }, state: State, context?: Context): unknown[] {
    if (!Array.isArray(valueObj.value)) return [];
    return valueObj.value.map((item) => this.resolveItem(item, state, context));
  }

  private resolveMap(valueObj: { value?: unknown }, state: State, context?: Context): Record<string, unknown> {
    if (!valueObj.value || typeof valueObj.value !== 'object') return {};
    const map = valueObj.value as Record<string, unknown>;
    const resolvedMap: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(map)) resolvedMap[key] = this.resolveItem(val, state, context);

    return resolvedMap;
  }

  /** At plan time an item only an apply can read is UNKNOWN on its own, so the list or map around it keeps what is known. */
  private resolveItem(value: unknown, state: State, context?: Context): unknown {
    try {
      return this.resolveValue(value, state, context);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError && this.planned.isPlanning())) throw error;
      return UNKNOWN;
    }
  }

  /** A template that is one interpolation is the value itself, type and all; text around it makes it a string. */
  private resolveTemplate(parts: TemplatePart[], state: State, context?: Context): unknown {
    const [first] = parts;
    if (parts.length === 1 && typeof first !== 'string') return this.resolve(first, state, context);

    return parts.map((part) => (typeof part === 'string' ? part : this.joined(part, state, context))).join('');
  }

  private joined(reference: ReferenceNode, state: State, context?: Context): string {
    const resolved = this.resolve(reference, state, context);
    const kind = kindOf(resolved);
    if (kind === 'list' || kind === 'map') throw new ConfigError(`${spellReference(reference.value)} is a ${kind} and cannot be joined into a string`, reference.position);

    return String(resolved);
  }
}
