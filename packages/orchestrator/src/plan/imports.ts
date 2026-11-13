import { Address, InstanceKey, ModuleAddress, Resource, State } from '@clay/contracts';
import { ImportBlock, ResourceBlock, spell } from '@clay/parser';
import { DesiredResource, PlanAction } from '@clay/planner';

import { LoadedModule, LoadedResource } from '../config/ModuleLoader';
import { withPlace } from '../place';
import { Limit } from '../providers/Limit';
import { ProviderRegistry } from '../providers/ProviderRegistry';

const refuse = (block: ImportBlock, message: string) => withPlace(new Error(message), block.position, spell(block), ModuleAddress.root);

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

/** What a key of the block's instances is; a block with neither has one instance and no key. */
function keyKind(block: ResourceBlock): 'number' | 'string' | undefined {
  if (block.count) return 'number';

  return block.forEach ? 'string' : undefined;
}

function keyName(kind: 'number' | 'string' | undefined): string {
  if (kind === 'number') return 'count, so an instance is named by a number, as in [0]';

  return kind === 'string' ? 'for_each, so an instance is named by a string, as in ["a"]' : 'neither count nor for_each, so it takes no key';
}

const kindOf = (key: InstanceKey | undefined) => (key === undefined ? undefined : typeof key === 'number' ? 'number' : 'string');

/** Before any value is known: `to` names a block of the root module that the provider can import, with a key of the kind its instances have. */
export function checkImports(imports: ImportBlock[], resources: LoadedResource[], providers: ProviderRegistry): void {
  for (const block of imports) {
    const { to } = block;
    const target = resources.find(({ address }) => address.module.isRoot() && address.resourceType === to.resourceType && address.name === to.name);
    if (!target) throw refuse(block, `import to ${to}, but the root module declares no resource "${to.resourceType}" "${to.name}"`);
    if (!providers.importable(to.resourceType)) throw refuse(block, `import to ${to}, but ${to.resourceType} cannot be imported`);

    const kind = keyKind(target.block);
    if (kindOf(to.key) !== kind) throw refuse(block, `import to ${to}, but ${spell(target.block)} has ${keyName(kind)}`);
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
  private needed = new Map<string, ImportBlock>();

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly limit: Limit,
    private readonly readBack: ReadBack
  ) {}

  /** After the moves, so `to` is skipped where the state already holds it, or holds what a count that came or went moves to it. */
  need(imports: ImportBlock[], state: State): void {
    const needed = imports.filter(({ to }) => ![to, ...to.countCounterparts()].some((held) => Object.hasOwn(state.resources, held.toString())));
    this.needed = new Map(needed.map((block) => [block.to.toString(), block]));
  }

  /** Into `state` as the walk reaches the instance, so the instance is planned against what was imported. */
  async importAt(address: Address, state: State): Promise<void> {
    const key = address.toString();
    const block = this.needed.get(key);
    if (!block) return;

    state.resources[key] = await this.importOne(block);
    this.ids.set(key, block.id);
  }

  private async importOne(block: ImportBlock): Promise<Resource> {
    const { to, id } = block;
    const nothing = () => refuse(block, `import to ${to} found no ${to.resourceType} with the id "${id}"`);
    try {
      const provider = this.providers.get(to.resourceType);
      const given = await this.limit.run(() => provider.importResource!(to.resourceType, id));
      if (given === null) throw nothing();

      // Read with no marks: they come from the block, which is planned after the import.
      const resource: Resource = { ...fieldsOf(to), attributes: given };
      const attributes = await this.limit.run(() => this.readBack(to.toString(), resource));
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
    for (const [key, block] of this.needed) if (!made.has(key)) throw refuse(block, `import to ${key}, but the configuration makes no such instance`);
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

/** A saved plan imports only what the configuration's import blocks say, by the same id. */
export function checkImportedFrom(actions: PlanAction[], imports: ImportBlock[]): void {
  const ids = new Map(imports.map((block) => [block.to.toString(), block.id]));

  for (const { importedFrom, ...action } of actions) {
    if (importedFrom === undefined) continue;

    const address = Address.of(action).toString();
    if (ids.get(address) !== importedFrom) throw new Error(`The saved plan imports ${address} from "${importedFrom}", which the configuration does not. Plan again.`);
  }
}
