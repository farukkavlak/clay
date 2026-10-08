import { Address, InstanceKey, ModuleAddress } from '@clay/contracts';

/**
 * Dependency graph keys. They are built here and never parsed.
 * The graph holds one node per block, not per module instance; a plan walks each node once per instance, pairing the key with the instance's scope.
 * A resource's key is its block address, `type.name`, so other kinds use a `:`, which no name can contain.
 */
export function variableKey(scope: string, name: string): string {
  return scope ? `${scope}.vars:${name}` : `vars:${name}`;
}

export function outputKey(scope: string, name: string): string {
  return scope ? `${scope}.outputs:${name}` : `outputs:${name}`;
}

/** Runs before anything inside the module. */
export function callKey(module: ModuleAddress): string {
  const scope = new ModuleAddress(module.path.slice(0, -1)).toString();
  const { name } = module.path.at(-1)!;

  return scope ? `${scope}.module:${name}` : `module:${name}`;
}

/** Shared by every instance of the resource, in every instance of its module. */
export function blockKey(address: Address): string {
  return new Address(address.module.withoutKeys(), address.resourceType, address.name).toString();
}

/** Apart from a resource's key, since a data source and a resource may share a type and a name. */
export function dataSourceKey(scope: string, type: string, name: string): string {
  return scope ? `${scope}.data:${type}.${name}` : `data:${type}.${name}`;
}

/** `module.m.data.local_file.f`, as a plan names it. */
export function dataSourceAddress(scope: string, type: string, name: string): string {
  return `${scope ? `${scope}.` : ''}data.${type}.${name}`;
}

/** Module inputs are read in the caller, for one module instance, whose key is `count.index` or `each.key`. */
export class ModuleCall {
  constructor(public readonly instance: ModuleAddress) {}

  get caller(): ModuleAddress {
    return new ModuleAddress(this.instance.path.slice(0, -1));
  }

  /** As `module.a[1].module.b`, shared by every instance it makes there. */
  get call(): ModuleAddress {
    return this.caller.child(this.instance.path.at(-1)!.name);
  }
}

/** A resource instance, a module (its variables and outputs), or a module call. */
export type Context = Address | ModuleAddress | ModuleCall;

export function moduleOf(context: Context): ModuleAddress {
  if (context instanceof Address) return context.module;

  return context instanceof ModuleCall ? context.caller : context;
}

/** `module.a.module.b` two modules deep, `''` at the root. */
export function scopeOf(context: Context): string {
  return moduleOf(context).toString();
}

/** Undefined for a module's own values, which belong to no instance. */
export function instanceKeyOf(context: Context): InstanceKey | undefined {
  if (context instanceof ModuleCall) return context.instance.path.at(-1)?.key;

  return context instanceof Address ? context.key : undefined;
}

/** `module.a[1]` for `module.a[1].module.b[0]` and `module.a`. */
export function enclosing(instance: ModuleAddress, module: ModuleAddress): ModuleAddress {
  return new ModuleAddress(instance.path.slice(0, module.path.length));
}

/** An input is read in the call that makes the instance, anything else in the instance itself. */
export function contextIn(context: ModuleAddress | ModuleCall, instance: ModuleAddress): ModuleAddress | ModuleCall {
  return context instanceof ModuleCall ? new ModuleCall(instance) : enclosing(instance, context);
}
