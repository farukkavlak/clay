import { ModuleAddress } from '@clay/contracts';

/** The instances of each module, by the module as the configuration writes it. The root has one; a module has them once the call that names it has run. */
export class ModuleInstances {
  private instances = new Map<string, ModuleAddress[]>();

  /** One instance of the module for each instance of the module that calls it. */
  expand(caller: ModuleAddress, name: string): void {
    this.instances.set(
      caller.child(name).toString(),
      this.of(caller).map((instance) => instance.child(name))
    );
  }

  /** A graph runs a module's call before anything in it, so a module asked for has had its instances made. */
  of(module: ModuleAddress): ModuleAddress[] {
    if (module.isRoot()) return [module];

    return this.instances.get(module.toString())!;
  }
}
