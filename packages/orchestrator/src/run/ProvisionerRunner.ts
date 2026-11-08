import { Address, DestroyProvisioner, Resource, State } from '@clay/contracts';
import { ProvisionerBlock, ResourceBlock, spell } from '@clay/parser';

import { ReferenceResolver } from '../expressions/ReferenceResolver';
import { tryAt } from '../place';
import { keptFor, ProvisionerConfig, ProvisionerFailed, Provisioning } from '../providers/Provisioning';

/** Where each line a provisioner prints goes, with the provisioner's type. */
export type ProvisionerPrint = (provisioner: string, line: string) => void;

/** Where a provisioner runs: the object, and the block that makes it. */
interface Provisioned {
  address: Address;
  declaration: string;
  print?: ProvisionerPrint;
}

function taint(state: State, address: Address): void {
  state.resources[address.toString()].tainted = true;
}

const destroyTime = (provisioner: ProvisionerBlock) => provisioner.when === 'destroy';

/** What a provisioner that failed under on_failure = continue prints. */
function goesOn(error: ProvisionerFailed): string {
  return `${error.message}, and the apply goes on as on_failure = continue says`;
}

/** Runs a block's provisioners on the object an action makes, and keeps those that run before it is destroyed. */
export class ProvisionerRunner {
  constructor(
    private provisioning: Provisioning,
    private resolver: ReferenceResolver
  ) {}

  /**
   * What runs before a destroy is kept first. Then the rest run in the order written. One that fails, or a value of either refused now,
   * leaves the object tainted, so the next plan replaces it, and the rest do not run; one with on_failure = continue fails alone.
   */
  async provision(on: Provisioned, resource: ResourceBlock, currentState: State): Promise<void> {
    try {
      await this.keepForDestroy(on.address, resource, currentState);
    } catch (error) {
      taint(currentState, on.address);
      throw error;
    }

    for (const provisioner of resource.provisioners?.filter((one) => !destroyTime(one)) ?? [])
      try {
        await this.runProvisioner(provisioner, on, currentState);
      } catch (error) {
        if (error instanceof ProvisionerFailed && provisioner.onFailure === 'continue') {
          on.print?.(provisioner.provisionerType.value, goesOn(error));
          continue;
        }
        taint(currentState, on.address);
        throw error;
      }
  }

  private async runProvisioner(provisioner: ProvisionerBlock, on: Provisioned, currentState: State): Promise<void> {
    const checked = await this.checkProvisioner(provisioner, on, currentState);
    const type = provisioner.provisionerType.value;
    await this.provisioning.run(type, checked, (line) => on.print?.(type, line));
  }

  /** Resolved now, as the resource's own values are, and checked again now that every value is known. */
  private async checkProvisioner(provisioner: ProvisionerBlock, { address, declaration }: Provisioned, currentState: State): Promise<ProvisionerConfig> {
    const given = Object.fromEntries(
      Object.entries(provisioner.attributes).map(([name, value]) => [
        name,
        tryAt(value.position, declaration, address, () => this.resolver.resolveValue(value, currentState, address)),
      ])
    );
    return this.provisioning.check(provisioner, given, declaration, address);
  }

  /**
   * Resolved with the object as state now holds it and kept beside it, so they run before it is destroyed, even once the block is gone.
   * Those the last apply kept go first, so a value refused now leaves none read from other values, and the next plan keeps them again.
   */
  async keepForDestroy(address: Address, resource: ResourceBlock | undefined, currentState: State): Promise<void> {
    if (!resource) return;

    const object = currentState.resources[address.toString()];
    delete object.destroyProvisioners;
    const on = { address, declaration: spell(resource) };
    const provisioners: DestroyProvisioner[] = [];
    for (const provisioner of resource.provisioners?.filter(destroyTime) ?? []) provisioners.push(keptFor(provisioner, await this.checkProvisioner(provisioner, on, currentState)));

    if (provisioners.length > 0) object.destroyProvisioners = provisioners;
    else delete object.destroyProvisioners;
  }

  /** In the order written. One that fails keeps the object, unless on_failure = continue. A tainted object was never fully made, so none run on it. */
  async runBeforeDestroy({ destroyProvisioners = [], tainted }: Pick<Resource, 'destroyProvisioners' | 'tainted'>, print: ProvisionerPrint | undefined): Promise<void> {
    if (tainted) return;

    for (const { type, config, sensitive = [], onFailure } of destroyProvisioners)
      try {
        await this.provisioning.run(type, { config, sensitive }, (line) => print?.(type, line));
      } catch (error) {
        if (!(error instanceof ProvisionerFailed && onFailure === 'continue')) throw error;
        print?.(type, goesOn(error));
      }
  }
}
