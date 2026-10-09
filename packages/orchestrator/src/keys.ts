import { Address, InstanceKey, ModuleAddress, spellKey } from '@clay/contracts';

/**
 * Dependency graph keys. They are built here and never parsed.
 * The graph holds one node per block, not per module instance; a plan walks each node once per instance, pairing the key with the instance's scope.
 * A resource's key is its block address, `type.name`, so other kinds use a `:`, which no name can contain.
 */
export function variableKey(scope: string, name: string): string {
  return scope ? `${scope}.vars:${name}` : `vars:${name}`;
}

export function localKey(scope: string, name: string): string {
  return scope ? `${scope}.locals:${name}` : `locals:${name}`;
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

/** `module.m[0].data.local_file.f[1]`, as a plan names it. */
export function dataSourceAddress(scope: string, type: string, name: string, key?: InstanceKey): string {
  return `${scope ? `${scope}.` : ''}data.${type}.${name}${spellKey(key)}`;
}

/** One data source instance in one module instance; its key is `count.index` or `each.key`. */
export class DataInstance {
  public readonly module: ModuleAddress;
  public readonly type: string;
  public readonly name: string;
  public readonly key?: InstanceKey;

  constructor(module: ModuleAddress, type: string, name: string, key?: InstanceKey) {
    this.module = module;
    this.type = type;
    this.name = name;
    this.key = key;
  }

  /** Its block in its module instance, where its count or for_each is read; shared by every instance it makes there. */
  get block(): string {
    return dataSourceKey(this.module.toString(), this.type, this.name);
  }

  /** One for each key its count or for_each gives, or itself where it has neither. */
  instances(keys: InstanceKey[] | undefined): DataInstance[] {
    if (keys === undefined) return [this];

    return keys.map((key) => new DataInstance(this.module, this.type, this.name, key));
  }

  toString(): string {
    return dataSourceAddress(this.module.toString(), this.type, this.name, this.key);
  }
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

/** A resource instance, a data source instance, a module (its variables, locals and outputs), or a module call. */
export type Context = Address | DataInstance | ModuleAddress | ModuleCall;

export function moduleOf(context: Context): ModuleAddress {
  if (context instanceof Address || context instanceof DataInstance) return context.module;

  return context instanceof ModuleCall ? context.caller : context;
}

/** `module.a.module.b` two modules deep, `''` at the root. */
export function scopeOf(context: Context): string {
  return moduleOf(context).toString();
}

/** Undefined for a module's own values, which belong to no instance. */
export function instanceKeyOf(context: Context): InstanceKey | undefined {
  if (context instanceof ModuleCall) return context.instance.path.at(-1)?.key;

  return context instanceof Address || context instanceof DataInstance ? context.key : undefined;
}

/** `module.a[1]` for `module.a[1].module.b[0]` and `module.a`. */
export function enclosing(instance: ModuleAddress, module: ModuleAddress): ModuleAddress {
  return new ModuleAddress(instance.path.slice(0, module.path.length));
}

/** An input is read in the call that makes the instance, anything else in the instance itself. */
export function contextIn(context: ModuleAddress | ModuleCall, instance: ModuleAddress): ModuleAddress | ModuleCall {
  return context instanceof ModuleCall ? new ModuleCall(instance) : enclosing(instance, context);
}
