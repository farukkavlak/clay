import { Address, ModuleAddress } from '@clay/contracts';

/**
 * How a node is addressed in the dependency graph. Keys are built here and never taken apart.
 * The graph holds a module as the configuration writes it, and a plan walks each node once for every instance of its module, so a value keeps its key with the instance's scope.
 * A resource's key is the address of its block, `type.name`, which every instance of it shares, so the others spell their kind with a `:`, which no name can hold.
 */
export function variableKey(scope: string, name: string): string {
  return scope ? `${scope}.vars:${name}` : `vars:${name}`;
}

export function outputKey(scope: string, name: string): string {
  return scope ? `${scope}.outputs:${name}` : `outputs:${name}`;
}

/** The call that makes the instances of a module, which runs before anything in them. */
export function callKey(module: ModuleAddress): string {
  const scope = new ModuleAddress(module.path.slice(0, -1)).toString();
  const { name } = module.path.at(-1)!;

  return scope ? `${scope}.module:${name}` : `module:${name}`;
}

/** The block every instance of a resource shares, in every instance of its module. */
export function blockKey(address: Address): string {
  return new Address(address.module.withoutKeys(), address.resourceType, address.name).toString();
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

/** The instance of `module` that `instance` sits in, or is: `module.a[1]` for `module.a[1].module.b[0]` and `module.a`. */
export function enclosing(instance: ModuleAddress, module: ModuleAddress): ModuleAddress {
  return new ModuleAddress(instance.path.slice(0, module.path.length));
}
