import { Address, ModuleAddress } from '@clay/contracts';

/**
 * How a node is addressed in the dependency graph. Keys are built here and never taken apart.
 * A resource's key is the address of its block, `type.name`, which every instance of it shares, so these two spell their kind with a `:`, which no name can hold.
 */
export function variableKey(scope: string, name: string): string {
  return scope ? `${scope}.vars:${name}` : `vars:${name}`;
}

export function outputKey(scope: string, name: string): string {
  return scope ? `${scope}.outputs:${name}` : `outputs:${name}`;
}

export function dataSourceKey(scope: string, type: string, name: string): string {
  return scope ? `${scope}.${type}.${name}` : `${type}.${name}`;
}

/** Where a value is read: in an instance of a resource, or among a module's own variables and outputs. */
export type Context = Address | ModuleAddress;

export function moduleOf(context: Context): ModuleAddress {
  return context instanceof ModuleAddress ? context : context.module;
}

/** The scope a module's values live in: `module.a.module.b` for a resource two modules deep, and `''` at the root. */
export function scopeOf(context: Context): string {
  return moduleOf(context).toString();
}
