import { Address, InstanceKey, ModuleAddress } from '@clay/contracts';

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

/** Where a module's inputs are read: in the module that calls it, for one instance of the module, whose index `count.index` is. */
export class ModuleCall {
  constructor(public readonly instance: ModuleAddress) {}

  get caller(): ModuleAddress {
    return new ModuleAddress(this.instance.path.slice(0, -1));
  }

  /** The call in the instance of the module that makes it, as `module.a[1].module.b`, which every instance it makes there shares. */
  get call(): ModuleAddress {
    return this.caller.child(this.instance.path.at(-1)!.name);
  }
}

/** Where a value is read: in an instance of a resource, among a module's own variables and outputs, or in a module call. */
export type Context = Address | ModuleAddress | ModuleCall;

export function moduleOf(context: Context): ModuleAddress {
  if (context instanceof Address) return context.module;

  return context instanceof ModuleCall ? context.caller : context;
}

/** The scope a module's values live in: `module.a.module.b` for a resource two modules deep, and `''` at the root. */
export function scopeOf(context: Context): string {
  return moduleOf(context).toString();
}

/** The key of the instance being made where a value is read: a resource's, or a module call's; a module's own values are read in no instance. */
export function instanceKeyOf(context: Context): InstanceKey | undefined {
  if (context instanceof ModuleCall) return context.instance.path.at(-1)?.key;

  return context instanceof Address ? context.key : undefined;
}

/** The instance of `module` that `instance` sits in, or is: `module.a[1]` for `module.a[1].module.b[0]` and `module.a`. */
export function enclosing(instance: ModuleAddress, module: ModuleAddress): ModuleAddress {
  return new ModuleAddress(instance.path.slice(0, module.path.length));
}

/** Where a module's value is read in one instance of the module: an input in the call that makes that instance, anything else in the instance it sits in. */
export function contextIn(context: ModuleAddress | ModuleCall, instance: ModuleAddress): ModuleAddress | ModuleCall {
  return context instanceof ModuleCall ? new ModuleCall(instance) : enclosing(instance, context);
}
