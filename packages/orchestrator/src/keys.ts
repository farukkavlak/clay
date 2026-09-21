import { Address } from '@clay/contracts';

/** How a node is addressed in the dependency graph. Keys are built here and never taken apart. */
export function variableKey(scope: string, name: string): string {
  return scope ? `${scope}.vars.${name}` : `vars.${name}`;
}

export function outputKey(scope: string, name: string): string {
  return scope ? `${scope}.outputs.${name}` : `outputs.${name}`;
}

export function dataSourceKey(scope: string, type: string, name: string): string {
  return scope ? `${scope}.${type}.${name}` : `${type}.${name}`;
}

export function childScope(scope: string, moduleName: string): string {
  return scope ? `${scope}.module.${moduleName}` : `module.${moduleName}`;
}

/** The scope a module's values live in: `module.a.module.b` for a resource two modules deep, and `''` at the root. */
export function scopeOf(address: Address): string {
  return address.modulePath.reduce((scope, moduleName) => childScope(scope, moduleName), '');
}
