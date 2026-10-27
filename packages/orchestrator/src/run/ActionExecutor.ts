import { Address, AttributePath, DeposedObject, Provider, Resource, Schema, State, touchesSensitive } from '@clay/contracts';
import { AttributeValue } from '@clay/parser';
import { offApply, offFinal, offPlan, PlanAction } from '@clay/planner';

import { conformValues } from '../values/conformValues';
import { keepPrior } from '../plan/ignoredChanges';
import { checkNesting, heldBy, hidingReason, inconsistent, tooDeep } from '../providers/providerResult';
import { ProviderRegistry } from '../providers/ProviderRegistry';
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

/** After any it already has for the address, so the oldest goes first. */
function depose(state: State, key: string, old: Resource): void {
  const left: DeposedObject = { attributes: old.attributes, ...(old.sensitive && { sensitive: old.sensitive }), ...(old.dependencies && { dependencies: old.dependencies }) };

  state.deposed = { ...state.deposed, [key]: [...(state.deposed?.[key] ?? []), left] };
}

/** What the block says now, so the state has it once the block is gone. */
function protect(resource: Resource, { preventDestroy }: PlanAction): void {
  if (preventDestroy) resource.preventDestroy = true;
  else delete resource.preventDestroy;
}

/** The expressions of a resource block, as the configuration gives them. */
export type Written = Record<string, AttributeValue>;

/** What an action runs with beside the plan. */
export interface Running {
  written?: Written;
  destroyed?: Resource;
}

export class ActionExecutor {
  constructor(
    private providers: ProviderRegistry,
    private resolver: ReferenceResolver,
    private planner: ResourcePlanner,
    private sameObjects: SameObjects,
    private versions: Versions
  ) {}

  /** Before the run, so a create onto an object the run will destroy is refused. */
  expect(actions: PlanAction[], currentState: State): void {
    this.sameObjects.expect(actions, currentState);
  }

  /**
   * `written` is what the action's block gives, resolved again for a create, an update or a replace. `destroyed` is the object of a
   * replace that was destroyed before it, so that only the create is left.
   */
  async execute(action: PlanAction, currentState: State, { written, destroyed }: Running = {}): Promise<void> {
    // A no-op only updates what state keeps beside the values, so it needs no provider.
    if (action.type === 'NO_OP') {
      this.recordUnchanged(action, currentState);
      return;
    }

    const provider = this.providers.get(action.resourceType);

    switch (action.type) {
      case 'CREATE': {
        await this.executeCreate(action, written, provider, currentState);
        break;
      }
      case 'UPDATE': {
        await this.executeUpdate(action, written, provider, currentState);
        break;
      }
      case 'REPLACE': {
        // Checked before the delete, so a value off the plan or refused by the provider leaves the resource untouched, unless it was destroyed first.
        const sending = await this.sendingFor(action, written, currentState, destroyed);
        if (destroyed) {
          await this.create(action, provider, currentState, sending);
          break;
        }
        if (action.createBeforeDestroy) {
          // The old object stays the current one until the new one exists, so a create that fails leaves it whole.
          await this.create(action, provider, currentState, sending, held(action, currentState));
          break;
        }

        await this.executeDelete(action, provider, currentState);
        await this.create(action, provider, currentState, sending);
        break;
      }
      case 'DELETE': {
        await (action.deposed ? this.executeDeleteDeposed(action, provider, currentState) : this.executeDelete(action, provider, currentState));
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
    const schema = await this.providers.schema(type);
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

  async executeCreate(action: PlanAction, written: Written | undefined, provider: Provider, currentState: State): Promise<void> {
    await this.create(action, provider, currentState, await this.sendingFor(action, written, currentState));
  }

  /** `replacing` is the object a replace made first leaves deposed, once the new one is in state. */
  private async create(action: PlanAction, provider: Provider, currentState: State, sending: Sending, replacing?: Resource): Promise<void> {
    const contextAddress = Address.of(action);

    const created = await hidingReason(
      action.resourceType,
      sending.hidden,
      () => provider.create(action.resourceType, { config: sending.inputs, planned: sending.after }),
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
  }

  async executeUpdate(action: PlanAction, written: Written | undefined, provider: Provider, currentState: State): Promise<void> {
    const sending = await this.sendingFor(action, written, currentState);

    const currentResource = held(action, currentState);
    const request = { prior: currentResource.attributes, config: sending.inputs, planned: sending.after };

    const hidden = [...sending.hidden, ...(currentResource.sensitive ?? [])];
    const updated = await hidingReason(action.resourceType, hidden, () => provider.update(action.resourceType, request), 'to update');
    currentResource.attributes = this.returned(sending, updated);
    currentResource.dependencies = action.dependencies ?? [];
    mark(currentResource, sending.sensitive);
    protect(currentResource, action);
    this.wrote(action);
    this.holdToPlan(action.resourceType, sending, updated, currentResource.attributes);
  }

  /** Dependencies, which parts are sensitive and whether a destroy is prevented can change while values do not, so a no-op still updates them. */
  private recordUnchanged(action: PlanAction, currentState: State): void {
    const resource = held(action, currentState);

    resource.dependencies = action.dependencies ?? [];
    mark(resource, action.sensitive ?? []);
    protect(resource, action);
    this.wrote(action);
  }

  /** One at a time, oldest first, each gone from state once destroyed, so a failure leaves the rest to the next run. */
  async executeDeleteDeposed(action: PlanAction, provider: Provider, currentState: State): Promise<void> {
    const address = Address.of(action).toString();
    const { deposed } = currentState;
    const objects = deposed?.[address];
    if (!deposed || !objects) throw new Error('state holds no deposed object for it, so the plan was made from another state');

    while (objects.length > 0) {
      const [object] = objects;
      await hidingReason(action.resourceType, object.sensitive ?? [], () => provider.delete(action.resourceType, object.attributes), 'to destroy');
      objects.shift();
    }

    delete deposed[address];
    if (Object.keys(deposed).length === 0) delete currentState.deposed;
  }

  /** A replace's object, destroyed before its turn so that what it reads can be destroyed after it. */
  async destroy(action: PlanAction, currentState: State): Promise<void> {
    await this.executeDelete(action, this.providers.get(action.resourceType), currentState);
  }

  async executeDelete(action: PlanAction, provider: Provider, currentState: State): Promise<void> {
    const { attributes, sensitive = [] } = held(action, currentState);
    await hidingReason(action.resourceType, sensitive, () => provider.delete(action.resourceType, attributes), 'to destroy');
    delete currentState.resources[Address.of(action).toString()];
    this.wrote(action);
  }

  /** Before any check that may throw: state already holds the write. */
  private wrote(action: PlanAction): void {
    this.versions.changed(Address.of(action).withoutKey().toString());
  }
}
