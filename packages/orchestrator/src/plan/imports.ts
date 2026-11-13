import { Address, ModuleAddress, Resource, State } from '@clay/contracts';
import { ImportBlock, spell } from '@clay/parser';
import { DesiredResource, PlanAction } from '@clay/planner';

import { LoadedModule, LoadedResource } from '../config/ModuleLoader';
import { withPlace } from '../place';
import { Limit } from '../providers/Limit';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { checkKey, ImportTarget, refuseImport } from './importTargets';

/** The import blocks of the root module. One elsewhere is refused: a module others call cannot know what each caller has. */
export function importsIn(modules: LoadedModule[]): ImportBlock[] {
  return modules.flatMap(({ address, program }) =>
    program.flatMap((statement) => {
      if (statement.type !== 'Import') return [];
      if (!address.isRoot()) throw withPlace(new Error('import is taken only in the root module'), statement.position, spell(statement), address);

      return [statement];
    })
  );
}

/** As written, `local_file.a[each.key]` where the key is read. */
const spelledTo = (block: ImportBlock) => spell(block).slice('import to '.length);

/**
 * Before any value is known: `to` names a block of the root module that the provider can import, with a key of the kind its instances have.
 * A key read from `each` is checked as the plan reads it.
 */
export function checkImports(imports: ImportBlock[], resources: LoadedResource[], providers: ProviderRegistry): void {
  for (const block of imports) {
    const { to } = block;
    const target = resources.find(({ address }) => address.module.isRoot() && address.resourceType === to.resourceType && address.name === to.name);
    if (!target) throw refuseImport(block, `import to ${spelledTo(block)}, but the root module declares no resource "${to.resourceType}" "${to.name}"`);
    if (!providers.importable(to.resourceType)) throw refuseImport(block, `import to ${spelledTo(block)}, but ${to.resourceType} cannot be imported`);
    if (!block.key) checkKey(block, to, target.block);
  }
}

/** Without a key or module path left undefined, as the state holds a resource. */
function fieldsOf(address: Address): Pick<Resource, 'resourceType' | 'name' | 'key'> {
  return { resourceType: address.resourceType, name: address.name, ...(address.key !== undefined && { key: address.key }) };
}

/** Reads the object as a refresh does, so it comes back in the form state holds. */
export type ReadBack = (key: string, resource: Resource) => Promise<Record<string, unknown> | null>;

/** Each address an object was imported to, and the id it was imported by. */
export class Imports {
  private readonly ids = new Map<string, string>();
  private readonly needed = new Map<string, ImportTarget>();
  private blocks: ImportBlock[] = [];

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly limit: Limit,
    private readonly readBack: ReadBack
  ) {}

  take(blocks: ImportBlock[]): void {
    this.blocks = blocks;
  }

  /** The blocks that import to a root resource; read as the walk reaches it, since a for_each may read what is planned before it. */
  blocksTo(resource: Address): ImportBlock[] {
    return resource.module.isRoot() ? this.blocks.filter(({ to }) => to.withoutKey().toString() === resource.toString()) : [];
  }

  /**
   * After the moves, and before any instance of the resource is planned, so a target is skipped where the state already holds it, or
   * holds what a count that came or went moves to it.
   */
  need(targets: ImportTarget[], state: State): void {
    for (const target of targets)
      if (![target.address, ...target.address.countCounterparts()].some((held) => Object.hasOwn(state.resources, held.toString())))
        this.needed.set(target.address.toString(), target);
  }

  /** What imports to the instance, where the state does not hold it yet. */
  neededAt(address: Address): ImportTarget | undefined {
    return this.needed.get(address.toString());
  }

  /** Into `state` as the walk reaches the instance, so the instance is planned against what was imported. */
  async importBy(target: ImportTarget, id: string, state: State): Promise<void> {
    const key = target.address.toString();
    state.resources[key] = await this.importOne(target, id);
    this.ids.set(key, id);
  }

  private async importOne({ block, address }: ImportTarget, id: string): Promise<Resource> {
    const nothing = () => refuseImport(block, `import to ${address} found no ${address.resourceType} with the id "${id}"`);
    try {
      const provider = this.providers.get(address.resourceType);
      const given = await this.limit.run(() => provider.importResource!(address.resourceType, id));
      if (given === null) throw nothing();

      // Read with no marks: they come from the block, which is planned after the import.
      const resource: Resource = { ...fieldsOf(address), attributes: given };
      const attributes = await this.limit.run(() => this.readBack(address.toString(), resource));
      if (attributes === null) throw nothing();

      return { ...resource, attributes };
    } catch (error) {
      throw withPlace(error, block.position, spell(block), ModuleAddress.root);
    }
  }

  idOf(address: string): string | undefined {
    return this.ids.get(address);
  }

  /** Every import is to an instance the configuration makes; one it does not make would be left in state with nothing to plan it. */
  checkPlanned(desired: { address: Address }[]): void {
    const made = new Set(desired.map(({ address }) => address.toString()));
    for (const [key, { block }] of this.needed) if (!made.has(key)) throw refuseImport(block, `import to ${key}, but the configuration makes no such instance`);
  }

  /**
   * Gives each imported object in `state` what its block keeps beside the values, before the actions are planned, so an import that
   * changes nothing plans no change of marks, protection or provisioners.
   */
  adopt(state: State, desired: DesiredResource[]): void {
    const byAddress = new Map(desired.map((resource) => [resource.address.toString(), resource]));

    for (const key of this.ids.keys()) {
      const { sensitive, dependencies, preventDestroy, destroyProvisioners } = byAddress.get(key)!;
      state.resources[key] = {
        ...state.resources[key],
        ...(sensitive.length > 0 && { sensitive }),
        dependencies,
        ...(preventDestroy && { preventDestroy }),
        ...(destroyProvisioners && destroyProvisioners.length > 0 && { destroyProvisioners }),
      };
    }
  }

  /** Each imported object as the plan leaves it, before its action runs. */
  imported(state: State): Record<string, Resource> {
    return Object.fromEntries([...this.ids.keys()].map((key) => [key, state.resources[key]]));
  }
}

/**
 * A saved plan imports only where the configuration has an import block; the id is the one the plan read and showed. A block with
 * for_each covers any instance of its resource, since only the plan reads which.
 */
export function checkImportedFrom(actions: PlanAction[], imports: ImportBlock[]): void {
  const exact = new Set(imports.filter((block) => !block.forEach).map((block) => block.to.toString()));
  const anyOf = new Set(imports.filter((block) => block.forEach).map((block) => block.to.withoutKey().toString()));

  for (const { importedFrom, ...action } of actions) {
    if (importedFrom === undefined) continue;

    const address = Address.of(action);
    if (!exact.has(address.toString()) && !anyOf.has(address.withoutKey().toString()))
      throw new Error(`The saved plan imports ${address.toString()} from "${importedFrom}", which the configuration does not. Plan again.`);
  }
}
