import { Address, Provider, State } from '@clay/contracts';
import { offApply, offPlan, PlanAction } from '@clay/planner';

import { inconsistentResult } from '../providerResult';
import { ProviderRegistry } from '../ProviderRegistry';
import { ReferenceResolver } from '../resolvers/ReferenceResolver';
import { shown } from '../shown';

/** What an action sends its provider, and what the provider planned it would make of them. */
interface Sending {
  inputs: Record<string, unknown>;
  after: Record<string, unknown>;
}

export class ActionExecutor {
  constructor(
    private providers: ProviderRegistry,
    private resolver: ReferenceResolver
  ) {}

  async execute(action: PlanAction, currentState: State): Promise<void> {
    // An unchanged resource only refreshes what it reads from, so it needs no provider.
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
        // Checked before the delete, so a value off the plan leaves the resource as it was.
        const sending = this.sendingFor(action, currentState);
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
   * The plan resolved these against an older state, so they are resolved again, and each value the plan showed as known has to come to the same.
   * A value only an apply makes is known now, and may come to anything.
   */
  private sendingFor(action: PlanAction, currentState: State): Sending {
    if (!action.attributes) throw new Error(`${action.type} action missing attributes`);
    if (!action.planned) throw new Error(`${action.type} action missing the values it was planned with`);
    if (!action.after) throw new Error(`${action.type} action missing what its provider planned`);

    const inputs = this.resolver.resolveAttributes(action.attributes, currentState, Address.of(action));
    const off = offPlan(action.planned, inputs);
    if (off) throw new Error(`the plan showed ${off.name} = ${shown(off.planned)}, but it now comes to ${shown(off.resolved)}. Plan again.`);

    return { inputs, after: action.after };
  }

  /** Checked once what it returned is in state: the resource exists as the provider made it, whatever the plan showed. */
  private holdToPlan(type: string, { inputs, after }: Sending, returned: Record<string, unknown>): void {
    const mismatches = offApply(after, inputs, returned);
    if (mismatches.length > 0) throw inconsistentResult(type, mismatches);
  }

  async executeCreate(action: PlanAction, provider: Provider, currentState: State): Promise<void> {
    await this.create(action, provider, currentState, this.sendingFor(action, currentState));
  }

  private async create(action: PlanAction, provider: Provider, currentState: State, sending: Sending): Promise<void> {
    const { inputs } = sending;
    const contextAddress = Address.of(action);

    await provider.validate(action.resourceType, inputs);
    const { id, attributes } = await provider.create(action.resourceType, inputs);

    const key = contextAddress.toString();
    currentState.resources[key] = {
      id,
      ...contextAddress.fields(),
      attributes,
      dependencies: action.dependencies ?? [],
    };
    this.holdToPlan(action.resourceType, sending, attributes);
  }

  async executeUpdate(action: PlanAction, provider: Provider, currentState: State): Promise<void> {
    const sending = this.sendingFor(action, currentState);
    const { inputs } = sending;

    const key = Address.of(action).toString();
    const currentResource = currentState.resources[key];
    if (!currentResource) throw new Error(`Resource "${key}" not found in state for update`);

    await provider.validate(action.resourceType, inputs);
    if (!action.id) throw new Error(`UPDATE action for "${key}" missing resource ID`);
    currentResource.attributes = await provider.update(action.id, action.resourceType, inputs);
    currentResource.dependencies = action.dependencies ?? [];
    this.holdToPlan(action.resourceType, sending, currentResource.attributes);
  }

  /** What a resource reads from can change while its values do not, so an unchanged resource still refreshes its list. */
  private recordDependencies(action: PlanAction, currentState: State): void {
    const key = Address.of(action).toString();
    const currentResource = currentState.resources[key];
    if (!currentResource) throw new Error(`Resource "${key}" not found in state`);

    currentResource.dependencies = action.dependencies ?? [];
  }

  async executeDelete(action: PlanAction, provider: Provider, currentState: State): Promise<void> {
    if (!action.id) throw new Error(`${action.type} action missing id`);

    const contextAddress = Address.of(action);

    await provider.delete(action.id, action.resourceType);
    const key = contextAddress.toString();
    delete currentState.resources[key];
  }
}
