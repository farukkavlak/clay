import { Address, Provider, Resource, Schema, State } from '@clay/contracts';
import { offApply, offFinal, offPlan, PlanAction } from '@clay/planner';

import { conformValues } from '../conformValues';
import { heldBy, inconsistent } from '../providerResult';
import { ProviderRegistry } from '../ProviderRegistry';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { shown } from '../shown';
import { TypeMismatch, typedValues } from '../typed';
import { plainOf, Value } from '../Value';
import { ResourcePlan, ResourcePlanner } from './ResourcePlanner';

/** As state holds it, which is how the provider finds it. */
function held(action: PlanAction, state: State): Resource {
  const key = Address.of(action).toString();
  const resource = Object.hasOwn(state.resources, key) ? state.resources[key] : undefined;
  if (!resource) throw new Error(`${action.type} of "${key}", which state does not hold`);

  return resource;
}

interface Sending {
  inputs: Record<string, unknown>;
  after: Record<string, unknown>;
  schema: Schema;
}

export class ActionExecutor {
  constructor(
    private providers: ProviderRegistry,
    private resolver: ReferenceResolver,
    private planner: ResourcePlanner
  ) {}

  async execute(action: PlanAction, currentState: State): Promise<void> {
    // A no-op only updates its dependencies, so it needs no provider.
    if (action.type === 'NO_OP') {
      this.recordDependencies(action, currentState);
      return;
    }

    const provider = this.providers.get(action.resourceType);

    switch (action.type) {
      case 'CREATE': {
        await this.executeCreate(action, provider, currentState);
        break;
      }
      case 'UPDATE': {
        await this.executeUpdate(action, provider, currentState);
        break;
      }
      case 'REPLACE': {
        // Checked before the delete, so a value off the plan or refused by the provider leaves the resource untouched.
        const sending = await this.sendingFor(action, currentState);
        await this.executeDelete(action, provider, currentState);
        await this.create(action, provider, currentState, sending);
        break;
      }
      case 'DELETE': {
        await this.executeDelete(action, provider, currentState);
        break;
      }
      default: {
        throw new Error(`Unknown action type: ${action.type}`);
      }
    }
  }

  /**
   * Resolved again now that earlier actions have run, and each value the plan knew must match.
   * The provider then validates and plans again before anything changes, since the plan could not validate unknown values.
   */
  private async sendingFor(action: PlanAction, currentState: State): Promise<Sending> {
    if (!action.attributes) throw new Error(`${action.type} action missing attributes`);
    if (!action.planned) throw new Error(`${action.type} action missing the values it was planned with`);
    if (!action.after) throw new Error(`${action.type} action missing what its provider planned`);

    const type = action.resourceType;
    const schema = await this.providers.schema(type);
    const inputs = this.resolver.resolveAttributes(action.attributes, currentState, Address.of(action));
    const off = offPlan(schema, action.planned, conformValues(type, schema, inputs));
    if (off) throw new Error(`the plan showed ${off.name} = ${shown(off.planned)}, but it now comes to ${shown(off.resolved)}. Plan again.`);

    const final = await this.finalPlan(action, schema, action.after, inputs, currentState);
    return { inputs: final.config, after: final.after, schema };
  }

  /** A replace is planned as a create. The approved plan's known values must still hold. */
  private async finalPlan(action: PlanAction, schema: Schema, after: Record<string, unknown>, inputs: Record<string, Value>, currentState: State): Promise<ResourcePlan> {
    const type = action.resourceType;
    const current = action.type === 'UPDATE' ? held(action, currentState) : undefined;
    const final = await this.planner.plan(type, schema, current, inputs);
    if (final.replace) throw new Error(`${type} planned at apply to replace what the plan changed in place, which is a bug in the provider`);

    const mismatches = offFinal(schema, after, final.after);
    if (mismatches.length > 0) throw inconsistent(type, 'plan', mismatches);

    return final;
  }

  /** Sets are reordered as a plan holds them, so the two compare. The resource exists whatever it holds, so data outside the schema is kept as returned. */
  private returned({ schema }: Sending, attributes: Record<string, unknown>): Record<string, unknown> {
    try {
      return plainOf(typedValues(schema, attributes));
    } catch (error) {
      if (!(error instanceof TypeMismatch)) throw error;
      return attributes;
    }
  }

  /** Runs after the result is in state, since the resource exists whatever its schema or the plan said. */
  private holdToPlan(type: string, { inputs, after, schema }: Sending, returned: Record<string, unknown>): void {
    heldBy(type, 'returned', schema, returned);
    const mismatches = offApply(schema, after, inputs, returned);
    if (mismatches.length > 0) throw inconsistent(type, 'apply', mismatches);
  }

  async executeCreate(action: PlanAction, provider: Provider, currentState: State): Promise<void> {
    await this.create(action, provider, currentState, await this.sendingFor(action, currentState));
  }

  private async create(action: PlanAction, provider: Provider, currentState: State, sending: Sending): Promise<void> {
    const contextAddress = Address.of(action);

    const attributes = this.returned(sending, await provider.create(action.resourceType, { config: sending.inputs, planned: sending.after }));

    const key = contextAddress.toString();
    currentState.resources[key] = {
      ...contextAddress.fields(),
      attributes,
      dependencies: action.dependencies ?? [],
    };
    this.holdToPlan(action.resourceType, sending, attributes);
  }

  async executeUpdate(action: PlanAction, provider: Provider, currentState: State): Promise<void> {
    const sending = await this.sendingFor(action, currentState);

    const currentResource = held(action, currentState);
    const request = { prior: currentResource.attributes, config: sending.inputs, planned: sending.after };

    currentResource.attributes = this.returned(sending, await provider.update(action.resourceType, request));
    currentResource.dependencies = action.dependencies ?? [];
    this.holdToPlan(action.resourceType, sending, currentResource.attributes);
  }

  /** Dependencies can change while values do not, so a no-op still updates them. */
  private recordDependencies(action: PlanAction, currentState: State): void {
    held(action, currentState).dependencies = action.dependencies ?? [];
  }

  async executeDelete(action: PlanAction, provider: Provider, currentState: State): Promise<void> {
    await provider.delete(action.resourceType, held(action, currentState).attributes);
    delete currentState.resources[Address.of(action).toString()];
  }
}
