import { IProvider } from '@miniform/contracts';
import { Graph } from '@miniform/graph';
import { PlanAction } from '@miniform/planner';
import { IState } from '@miniform/state';

import { Address } from '../Address';
import { GraphNode } from './DependencyGraphBuilder';
import { LoadedModule } from './ModuleLoader';

export class ActionExecutor {
  constructor(
    private providers: Map<string, IProvider>,
    private convertAttributes: (attributes: Record<string, unknown>, state: IState, context?: Address) => Record<string, unknown>,
    private resolveOutputsOf: (scope: string, loadedModules: LoadedModule[], currentState: IState) => void
  ) {}

  async executeActionsSequentially(actions: PlanAction[], graph: Graph<GraphNode>, currentState: IState, loadedModules: LoadedModule[]): Promise<void> {
    const layers = graph.topologicalSort();
    const actionMap = new Map<string, PlanAction>();

    // Pre-compute map for O(1) lookup
    for (const action of actions) {
      const key = new Address(action.modulePath || [], action.resourceType, action.name).toString();
      actionMap.set(key, action);
    }

    for (const layer of layers)
      await Promise.all(
        layer.map(async (key: string) => {
          const node = graph.getNode(key);
          if (node?.kind === 'output') {
            this.resolveOutputsOf(node.scope, loadedModules, currentState);
            return;
          }

          // Execute resource action if it matches a plan action
          const action = actionMap.get(key);
          if (action) await this.executeAction(action, currentState);
        })
      );
  }

  private async executeAction(action: PlanAction, currentState: IState): Promise<void> {
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
      case 'DELETE': {
        await this.executeDelete(action, provider, currentState);
        break;
      }
      case 'NO_OP': {
        break;
      }
      default: {
        throw new Error(`Unknown action type: ${action.type}`);
      }
    }
  }

  async executeCreate(action: PlanAction, provider: IProvider, currentState: IState): Promise<void> {
    if (!action.attributes) throw new Error('CREATE action missing attributes');

    const contextAddress = new Address(action.modulePath || [], action.resourceType, action.name);
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
    };
  }

  async executeUpdate(action: PlanAction, provider: IProvider, currentState: IState): Promise<void> {
    if (!action.attributes) throw new Error('UPDATE action missing attributes');

    const contextAddress = new Address(action.modulePath || [], action.resourceType, action.name);

    const key = contextAddress.toString();
    const currentResource = currentState.resources[key];
    if (!currentResource) throw new Error(`Resource "${key}" not found in state for update`);

    // The plan resolved these against an older state, so resolve them again here.
    const inputs = { ...currentResource.attributes, ...this.convertAttributes(action.attributes, currentState, contextAddress) };

    await provider.validate(action.resourceType, inputs);
    if (!action.id) throw new Error(`UPDATE action for "${key}" missing resource ID`);
    await provider.update(action.id, action.resourceType, inputs);

    currentResource.attributes = inputs;
  }

  async executeDelete(action: PlanAction, provider: IProvider, currentState: IState): Promise<void> {
    if (!action.id) throw new Error('DELETE action missing id');

    const contextAddress = new Address(action.modulePath || [], action.resourceType, action.name);

    await provider.delete(action.id, action.resourceType);
    const key = contextAddress.toString();
    delete currentState.resources[key];
  }
}
