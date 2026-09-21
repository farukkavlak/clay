import { Address, IProvider, IState } from '@clay/contracts';
import { PlanAction } from '@clay/planner';

export class ActionExecutor {
  constructor(
    private providers: Map<string, IProvider>,
    private convertAttributes: (attributes: Record<string, unknown>, state: IState, context?: Address) => Record<string, unknown>
  ) {}

  async execute(action: PlanAction, currentState: IState): Promise<void> {
    // An unchanged resource only refreshes what it reads from, so it needs no provider.
    if (action.type === 'NO_OP') {
      this.recordDependencies(action, currentState);
      return;
    }

    const provider = this.providers.get(action.resourceType);
    if (!provider) throw new Error(`No provider registered for resource type "${action.resourceType}"`);

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
        await this.executeDelete(action, provider, currentState);
        await this.executeCreate(action, provider, currentState);
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

  async executeCreate(action: PlanAction, provider: IProvider, currentState: IState): Promise<void> {
    if (!action.attributes) throw new Error('CREATE action missing attributes');

    const contextAddress = Address.of(action);
    const inputs = this.convertAttributes(action.attributes, currentState, contextAddress);

    await provider.validate(action.resourceType, inputs);
    const id = await provider.create(action.resourceType, inputs);

    const key = contextAddress.toString();
    // eslint-disable-next-line require-atomic-updates
    currentState.resources[key] = {
      id,
      type: 'Resource',
      resourceType: action.resourceType,
      name: contextAddress.name,
      modulePath: contextAddress.modulePath,
      attributes: inputs,
      dependencies: action.dependencies ?? [],
    };
  }

  async executeUpdate(action: PlanAction, provider: IProvider, currentState: IState): Promise<void> {
    if (!action.attributes) throw new Error('UPDATE action missing attributes');

    const contextAddress = Address.of(action);

    const key = contextAddress.toString();
    const currentResource = currentState.resources[key];
    if (!currentResource) throw new Error(`Resource "${key}" not found in state for update`);

    // The plan resolved these against an older state, so resolve them again here.
    const inputs = this.convertAttributes(action.attributes, currentState, contextAddress);

    await provider.validate(action.resourceType, inputs);
    if (!action.id) throw new Error(`UPDATE action for "${key}" missing resource ID`);
    await provider.update(action.id, action.resourceType, inputs);

    currentResource.attributes = inputs;
    currentResource.dependencies = action.dependencies ?? [];
  }

  /** What a resource reads from can change while its values do not, so an unchanged resource still refreshes its list. */
  private recordDependencies(action: PlanAction, currentState: IState): void {
    const key = Address.of(action).toString();
    const currentResource = currentState.resources[key];
    if (!currentResource) throw new Error(`Resource "${key}" not found in state`);

    currentResource.dependencies = action.dependencies ?? [];
  }

  async executeDelete(action: PlanAction, provider: IProvider, currentState: IState): Promise<void> {
    if (!action.id) throw new Error(`${action.type} action missing id`);

    const contextAddress = Address.of(action);

    await provider.delete(action.id, action.resourceType);
    const key = contextAddress.toString();
    delete currentState.resources[key];
  }
}
