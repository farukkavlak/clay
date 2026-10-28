import { Address, AttributePath, DeposedObject, DestroyProvisioner, Provider, Resource, Schema, State, touchesSensitive } from '@clay/contracts';
import { AttributeValue, ProvisionerBlock, ResourceBlock, spell } from '@clay/parser';
import { offApply, offFinal, offPlan, PlanAction } from '@clay/planner';

import { conformValues } from '../values/conformValues';
import { keepPrior } from '../plan/ignoredChanges';
import { checkNesting, heldBy, hidingReason, inconsistent, tooDeep } from '../providers/providerResult';
import { Limit } from '../providers/Limit';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { keptFor, ProvisionerConfig, ProvisionerFailed, Provisioning } from '../providers/Provisioning';
import { tryAt } from '../place';
import { SameObjects } from '../checks/sameObject';
import { ReferenceResolver } from '../expressions/ReferenceResolver';
import { shown } from '../shown';
import { TypeMismatch, typedValues } from '../values/typed';
import { plainOf, sensitiveAmong, Value } from '../values/Value';
import { Versions } from '../values/Versions';
import { Ignoring, ResourcePlan, ResourcePlanner } from '../plan/ResourcePlanner';

/** As state holds it, which is how the provider finds it. */
function held(action: PlanAction, state: State): Resource {
  const key = Address.of(action).toString();
  const resource = Object.hasOwn(state.resources, key) ? state.resources[key] : undefined;
  if (!resource) throw new Error('state holds no object for it, so the plan was made from another state');

  return resource;
}

interface Sending {
  inputs: Record<string, unknown>;
  after: Record<string, unknown>;
  sensitive: AttributePath[];
  /** Sensitive in the plan or now, so an error hides it whichever way the apply came to differ. */
  hidden: AttributePath[];
  schema: Schema;
}

/** Left out where no part is, so a value sensitive no more loses its mark. */
function mark(resource: Resource, sensitive: AttributePath[]): void {
  if (sensitive.length > 0) resource.sensitive = sensitive;
  else delete resource.sensitive;
}

/** An attribute the plan or the apply holds sensitive is named and not quoted. */
function offPlanMessage(off: NonNullable<ReturnType<typeof offPlan>>, hidden: AttributePath[]): string {
  if (touchesSensitive(hidden, [off.name])) return `the plan showed ${off.name}, which is sensitive, but it now comes to another value. Plan again.`;

  return `the plan showed ${off.name} = ${shown(off.planned)}, but it now comes to ${shown(off.resolved)}. Plan again.`;
}

/** After any it already has for the address, so the oldest goes first. A tainted object keeps nothing to run before its destroy. */
function depose(state: State, key: string, old: Resource): void {
  const left: DeposedObject = {
    attributes: old.attributes,
    ...(old.sensitive && { sensitive: old.sensitive }),
    ...(old.dependencies && { dependencies: old.dependencies }),
    ...(old.destroyProvisioners && !old.tainted && { destroyProvisioners: old.destroyProvisioners }),
  };

  state.deposed = { ...state.deposed, [key]: [...(state.deposed?.[key] ?? []), left] };
}

/** What the block says now, so the state has it once the block is gone. */
function protect(resource: Resource, { preventDestroy }: PlanAction): void {
  if (preventDestroy) resource.preventDestroy = true;
  else delete resource.preventDestroy;
}

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

/** The expressions of a resource block, as the configuration gives them. */
export type Written = Record<string, AttributeValue>;

/** Where each line a provisioner prints goes, with the provisioner's type. */
export type ProvisionerPrint = (provisioner: string, line: string) => void;

/** What an action runs with beside the plan. */
export interface Running {
  written?: Written;
  destroyed?: Resource;
  /** The block it is made from, whose provisioners run in order on the object a create makes, or are kept to run before it is destroyed. */
  resource?: ResourceBlock;
  print?: ProvisionerPrint;
}

export class ActionExecutor {
  constructor(
    private providers: ProviderRegistry,
    private provisioning: Provisioning,
    private resolver: ReferenceResolver,
    private planner: ResourcePlanner,
    private sameObjects: SameObjects,
    private versions: Versions,
    private limit: Limit
  ) {}

  /** Before the run, so a create onto an object the run will destroy is refused. */
  expect(actions: PlanAction[], currentState: State): void {
    this.sameObjects.expect(actions, currentState);
  }

  /**
   * `written` is what the action's block gives, resolved again for a create, an update or a replace. `destroyed` is the object of a
   * replace that was destroyed before it, so that only the create is left. `resource` is the block, whose provisioners run once a create or a replace has made its object.
   */
  async execute(action: PlanAction, currentState: State, running: Running = {}): Promise<void> {
    const { written } = running;
    // A no-op only updates what state keeps beside the values, so it needs no provider.
    if (action.type === 'NO_OP') {
      await this.recordUnchanged(action, currentState, running);
      return;
    }

    const provider = this.providers.get(action.resourceType);

    switch (action.type) {
      case 'CREATE': {
        await this.executeCreate(action, written, provider, currentState, running);
        break;
      }
      case 'UPDATE': {
        await this.executeUpdate(action, written, provider, currentState, running);
        break;
      }
      case 'REPLACE': {
        await this.executeReplace(action, provider, currentState, running);
        break;
      }
      case 'DELETE': {
        await (action.deposed ? this.executeDeleteDeposed(action, provider, currentState, running.print) : this.executeDelete(action, provider, currentState, running.print));
        break;
      }
      default: {
        throw new Error(`Unknown action type: ${action.type}`);
      }
    }
  }

  /**
   * Resolved again now that earlier actions have run, and each value the plan knew must match.
   * The provider then validates and plans again before anything changes, since the plan could not validate unknown values,
   * and what the object now is must be no other object's.
   */
  private async sendingFor(action: PlanAction, written: Written | undefined, currentState: State, destroyed?: Resource): Promise<Sending> {
    if (!written) throw new Error(`${action.type} action missing what its block gives`);
    if (!action.planned) throw new Error(`${action.type} action missing the values it was planned with`);
    if (!action.after) throw new Error(`${action.type} action missing what its provider planned`);

    const type = action.resourceType;
    const schema = await this.limit.run(() => this.providers.schema(type));
    const inputs = this.resolver.resolveAttributes(written, currentState, Address.of(action));
    const ignoring = this.ignoringFor(action, currentState, destroyed);
    const conformed = conformValues(type, schema, inputs);
    const off = offPlan(schema, action.planned, ignoring ? keepPrior(conformed, [], ignoring.prior, ignoring.paths).config : conformed);
    const hidden = [...(action.sensitive ?? []), ...sensitiveAmong(inputs)];
    if (off) throw new Error(offPlanMessage(off, hidden));

    const final = await this.finalPlan(action, schema, action.after, inputs, currentState, hidden, ignoring);
    await this.sameObjects.claim(action, final.after, hidden, currentState);
    return { inputs: final.config, after: final.after, sensitive: final.sensitive, hidden, schema };
  }

  /** The paths the plan left as the state has them. A replace is still held when this runs, unless it was destroyed first. */
  private ignoringFor(action: PlanAction, currentState: State, destroyed?: Resource): Ignoring | undefined {
    return action.ignored ? { prior: destroyed ?? held(action, currentState), paths: action.ignored } : undefined;
  }

  /** A replace is planned as a create. The approved plan's known values must still hold. */
  private async finalPlan(
    action: PlanAction,
    schema: Schema,
    after: Record<string, unknown>,
    inputs: Record<string, Value>,
    currentState: State,
    hidden: AttributePath[],
    ignoring: Ignoring | undefined
  ): Promise<ResourcePlan> {
    const type = action.resourceType;
    const current = action.type === 'UPDATE' ? held(action, currentState) : undefined;
    const final = await this.planner.plan(type, schema, current, inputs, ignoring);
    if (final.replace) throw new Error(`${type} planned at apply to replace what the plan changed in place, which is a bug in the provider`);

    const mismatches = offFinal(schema, after, final.after);
    if (mismatches.length > 0) throw inconsistent(type, 'plan', mismatches, hidden);

    return final;
  }

  /**
   * Sets are reordered as a plan holds them, so the two compare. The resource exists whatever it holds, so data outside the schema is kept as returned,
   * but a value nested too deep is left out, as state could not be read back with it.
   */
  private returned({ schema }: Sending, returned: Record<string, unknown>): Record<string, unknown> {
    const deep = new Set(tooDeep(returned));
    const attributes = Object.fromEntries(Object.entries(returned).filter(([name]) => !deep.has(name)));

    try {
      return plainOf(typedValues(schema, attributes));
    } catch (error) {
      if (!(error instanceof TypeMismatch)) throw error;
      return attributes;
    }
  }

  /** Runs after the result is in state, since the resource exists whatever its schema or the plan said. */
  private holdToPlan(type: string, { inputs, after, hidden, schema }: Sending, returned: Record<string, unknown>, kept: Record<string, unknown>): void {
    checkNesting(type, 'returned', returned);
    heldBy(type, 'returned', schema, kept);
    const mismatches = offApply(schema, after, inputs, kept);
    if (mismatches.length > 0) throw inconsistent(type, 'apply', mismatches, hidden);
  }

  private async executeReplace(action: PlanAction, provider: Provider, currentState: State, running: Running): Promise<void> {
    const { written, destroyed } = running;
    // Checked before the delete, so a value off the plan or refused by the provider leaves the resource untouched, unless it was destroyed first.
    const sending = await this.sendingFor(action, written, currentState, destroyed);
    if (destroyed) {
      await this.create(action, provider, currentState, sending, running);
      return;
    }
    if (action.createBeforeDestroy) {
      // The old object stays the current one until the new one exists, so a create that fails leaves it whole.
      await this.create(action, provider, currentState, sending, running, held(action, currentState));
      return;
    }

    await this.executeDelete(action, provider, currentState, running.print);
    await this.create(action, provider, currentState, sending, running);
  }

  async executeCreate(action: PlanAction, written: Written | undefined, provider: Provider, currentState: State, running: Running = {}): Promise<void> {
    await this.create(action, provider, currentState, await this.sendingFor(action, written, currentState), running);
  }

  /** `replacing` is the object a replace made first leaves deposed, once the new one is in state. */
  private async create(action: PlanAction, provider: Provider, currentState: State, sending: Sending, { resource, print }: Running, replacing?: Resource): Promise<void> {
    const contextAddress = Address.of(action);

    const created = await hidingReason(
      action.resourceType,
      sending.hidden,
      () => this.limit.run(() => provider.create(action.resourceType, { config: sending.inputs, planned: sending.after })),
      'to create'
    );
    const attributes = this.returned(sending, created);

    const key = contextAddress.toString();
    currentState.resources[key] = {
      ...contextAddress.fields(),
      attributes,
      dependencies: action.dependencies ?? [],
    };
    if (replacing) depose(currentState, key, replacing);
    mark(currentState.resources[key], sending.sensitive);
    protect(currentState.resources[key], action);
    this.wrote(action);
    this.holdToPlan(action.resourceType, sending, created, attributes);
    if (resource) await this.provision({ address: contextAddress, declaration: spell(resource), print }, resource, currentState);
  }

  /**
   * What runs before a destroy is kept first. Then the rest run in the order written. One that fails, or a value of either refused now,
   * leaves the object tainted, so the next plan replaces it, and the rest do not run; one with on_failure = continue fails alone.
   */
  private async provision(on: Provisioned, resource: ResourceBlock, currentState: State): Promise<void> {
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
  private async keepForDestroy(address: Address, resource: ResourceBlock | undefined, currentState: State): Promise<void> {
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
  private async runBeforeDestroy({ destroyProvisioners = [], tainted }: Pick<Resource, 'destroyProvisioners' | 'tainted'>, print: ProvisionerPrint | undefined): Promise<void> {
    if (tainted) return;

    for (const { type, config, sensitive = [], onFailure } of destroyProvisioners)
      try {
        await this.provisioning.run(type, { config, sensitive }, (line) => print?.(type, line));
      } catch (error) {
        if (!(error instanceof ProvisionerFailed && onFailure === 'continue')) throw error;
        print?.(type, goesOn(error));
      }
  }

  async executeUpdate(action: PlanAction, written: Written | undefined, provider: Provider, currentState: State, { resource }: Running = {}): Promise<void> {
    const sending = await this.sendingFor(action, written, currentState);

    const currentResource = held(action, currentState);
    const request = { prior: currentResource.attributes, config: sending.inputs, planned: sending.after };

    const hidden = [...sending.hidden, ...(currentResource.sensitive ?? [])];
    const updated = await hidingReason(action.resourceType, hidden, () => this.limit.run(() => provider.update(action.resourceType, request)), 'to update');
    currentResource.attributes = this.returned(sending, updated);
    currentResource.dependencies = action.dependencies ?? [];
    mark(currentResource, sending.sensitive);
    protect(currentResource, action);
    this.wrote(action);
    await this.keepForDestroy(Address.of(action), resource, currentState);
    this.holdToPlan(action.resourceType, sending, updated, currentResource.attributes);
  }

  /** Dependencies, which parts are sensitive, whether a destroy is prevented and what runs before it can change while values do not, so a no-op still updates them. */
  private async recordUnchanged(action: PlanAction, currentState: State, { resource }: Running): Promise<void> {
    const object = held(action, currentState);

    object.dependencies = action.dependencies ?? [];
    mark(object, action.sensitive ?? []);
    protect(object, action);
    this.wrote(action);
    await this.keepForDestroy(Address.of(action), resource, currentState);
  }

  /** One at a time, oldest first, each after what it kept to run before its destroy, and gone from state once destroyed, so a failure leaves the rest to the next run. */
  async executeDeleteDeposed(action: PlanAction, provider: Provider, currentState: State, print?: ProvisionerPrint): Promise<void> {
    const address = Address.of(action).toString();
    const { deposed } = currentState;
    const objects = deposed?.[address];
    if (!deposed || !objects) throw new Error('state holds no deposed object for it, so the plan was made from another state');

    while (objects.length > 0) {
      const [object] = objects;
      await this.runBeforeDestroy(object, print);
      await hidingReason(action.resourceType, object.sensitive ?? [], () => this.limit.run(() => provider.delete(action.resourceType, object.attributes)), 'to destroy');
      objects.shift();
    }

    delete deposed[address];
    if (Object.keys(deposed).length === 0) delete currentState.deposed;
  }

  /** A replace's object, destroyed before its turn so that what it reads can be destroyed after it. */
  async destroy(action: PlanAction, currentState: State, print?: ProvisionerPrint): Promise<void> {
    await this.executeDelete(action, this.providers.get(action.resourceType), currentState, print);
  }

  async executeDelete(action: PlanAction, provider: Provider, currentState: State, print?: ProvisionerPrint): Promise<void> {
    const object = held(action, currentState);
    await this.runBeforeDestroy(object, print);
    const { attributes, sensitive = [] } = object;
    await hidingReason(action.resourceType, sensitive, () => this.limit.run(() => provider.delete(action.resourceType, attributes)), 'to destroy');
    delete currentState.resources[Address.of(action).toString()];
    this.wrote(action);
  }

  /** Before any check that may throw: state already holds the write. */
  private wrote(action: PlanAction): void {
    this.versions.changed(Address.of(action).withoutKey().toString());
  }
}
