import { IProvider } from '@miniform/contracts';
import { Graph } from '@miniform/graph';
import { PlanAction } from '@miniform/planner';
import { IState } from '@miniform/state';
import { afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';

import { Address } from '../../src/Address';
import { ActionExecutor } from '../../src/components/ActionExecutor';
import { GraphNode } from '../../src/components/DependencyGraphBuilder';

describe('ActionExecutor', () => {
  let providers: Map<string, IProvider>;
  let convertAttributes: Mock;
  let resolveOutputsOf: Mock;
  let executor: ActionExecutor;
  let mockProvider: IProvider;

  beforeEach(() => {
    mockProvider = {
      resources: ['test'],
      validate: vi.fn(),
      create: vi.fn().mockResolvedValue('created-id'),
      update: vi.fn(),
      delete: vi.fn(),
      read: vi.fn(),
      getSchema: vi.fn(),
    };

    providers = new Map([['test', mockProvider]]);
    convertAttributes = vi.fn((attrs) => {
      const resolved: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(attrs))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (val && typeof val === 'object' && 'value' in (val as any))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          resolved[key] = (val as any).value;
        else resolved[key] = val;

      return resolved;
    });
    resolveOutputsOf = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor = new ActionExecutor(providers, convertAttributes as any, resolveOutputsOf as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const mockState: IState = {
    version: 1,
    resources: {},
  };

  const context = new Address([], 'test', 'main');

  describe('executeAction', () => {
    it('should throw if provider not found', async () => {
      const action: PlanAction = {
        type: 'CREATE',
        resourceType: 'unknown',
        name: 'main',
        attributes: {},
      };

      const actionAddress = new Address([], 'unknown', 'main');
      const graph = new Graph<GraphNode>();
      graph.addNode(actionAddress.toString(), { kind: 'resource' });

      await expect(executor.executeActionsSequentially([action], graph, mockState, [])).rejects.toThrow('No provider registered');
    });

    it('should throw on unknown action type', async () => {
      const action: PlanAction = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: 'UNKNOWN' as any,
        resourceType: 'test',
        name: 'main',
        attributes: {},
      };

      const actionAddress = new Address([], 'test', 'main');
      const graph = new Graph<GraphNode>();
      graph.addNode(actionAddress.toString(), { kind: 'resource' });

      await expect(executor.executeActionsSequentially([action], graph, mockState, [])).rejects.toThrow('Unknown action type');
    });

    it('should ignore NO_OP actions', async () => {
      const action: PlanAction = {
        type: 'NO_OP',
        resourceType: 'test',
        name: 'main',
      };

      const actionAddress = new Address([], 'test', 'main');
      const graph = new Graph<GraphNode>();
      graph.addNode(actionAddress.toString(), { kind: 'resource' });

      await executor.executeActionsSequentially([action], graph, mockState, []);
      expect(mockProvider.create).not.toHaveBeenCalled();
      expect(mockProvider.update).not.toHaveBeenCalled();
      expect(mockProvider.delete).not.toHaveBeenCalled();
    });

    it('should execute DELETE action via sequential execution', async () => {
      const action: PlanAction = {
        type: 'DELETE',
        resourceType: 'test',
        name: 'main',
        id: 'existing-id',
      };

      const actionAddress = new Address([], 'test', 'main');
      const graph = new Graph<GraphNode>();
      graph.addNode(actionAddress.toString(), { kind: 'resource' });

      await executor.executeActionsSequentially([action], graph, mockState, []);
      expect(mockProvider.delete).toHaveBeenCalledWith('existing-id', 'test');
    });
  });

  describe('executeCreate', () => {
    it('should throw if CREATE action missing attributes', async () => {
      const action: PlanAction = {
        type: 'CREATE',
        resourceType: 'test',
        name: 'main',
      };

      await expect(executor.executeCreate(action, mockProvider, mockState)).rejects.toThrow('missing attributes');
    });
  });

  describe('executeUpdate', () => {
    it('should throw if UPDATE action missing attributes', async () => {
      const action: PlanAction = {
        type: 'UPDATE',
        resourceType: 'test',
        name: 'main',
        id: 'id',
      };

      await expect(executor.executeUpdate(action, mockProvider, mockState)).rejects.toThrow('missing attributes');
    });

    it('should throw if resource not found in state', async () => {
      const action: PlanAction = {
        type: 'UPDATE',
        resourceType: 'test',
        name: 'missing',
        id: 'id',
        attributes: {},
      };

      // Ensure state is empty
      mockState.resources = {};

      await expect(executor.executeUpdate(action, mockProvider, mockState)).rejects.toThrow('not found in state');
    });

    it('should throw if UPDATE action missing resource ID', async () => {
      const key = context.toString();
      mockState.resources[key] = {
        id: 'existing',
        type: 'Resource',
        resourceType: 'test',
        name: 'main',
        attributes: {},
      };

      const action: PlanAction = {
        type: 'UPDATE',
        resourceType: 'test',
        name: 'main',
        attributes: {},
        // missing id
      };

      await expect(executor.executeUpdate(action, mockProvider, mockState)).rejects.toThrow('missing resource ID');
    });

    it('should send only the config attributes and drop the ones the config no longer sets', async () => {
      const key = context.toString();
      mockState.resources[key] = {
        id: 'existing',
        type: 'Resource',
        resourceType: 'test',
        name: 'main',
        attributes: { old: 'val', dropped: 'val' },
      };

      const action: PlanAction = {
        type: 'UPDATE',
        resourceType: 'test',
        name: 'main',
        id: 'existing',
        attributes: { old: { type: 'String', value: 'updated' } },
      };

      await executor.executeUpdate(action, mockProvider, mockState);

      expect(mockProvider.update).toHaveBeenCalledWith('existing', 'test', { old: 'updated' });
      expect(mockState.resources[key].attributes).toEqual({ old: 'updated' });
    });
  });

  describe('REPLACE', () => {
    it('should delete the old resource, create the new one and keep it in state', async () => {
      const key = context.toString();
      mockState.resources[key] = { id: 'old', type: 'Resource', resourceType: 'test', name: 'main', attributes: { path: 'old' } };
      const action: PlanAction = { type: 'REPLACE', resourceType: 'test', name: 'main', id: 'old', attributes: { path: { type: 'String', value: 'new' } } };
      const graph = new Graph<GraphNode>();
      graph.addNode(key, { kind: 'resource' });

      await executor.executeActionsSequentially([action], graph, mockState, []);

      expect(mockProvider.delete).toHaveBeenCalledWith('old', 'test');
      expect(mockProvider.create).toHaveBeenCalledWith('test', { path: 'new' });
      expect(mockState.resources[key]).toMatchObject({ id: 'created-id', attributes: { path: 'new' } });
    });
  });

  describe('executeDelete', () => {
    it('should throw if DELETE action missing id', async () => {
      const action: PlanAction = {
        type: 'DELETE',
        resourceType: 'test',
        name: 'main',
      };

      await expect(executor.executeDelete(action, mockProvider, mockState)).rejects.toThrow('missing id');
    });
  });

  describe('Graph Execution', () => {
    it("should resolve the outputs of an output node's scope", async () => {
      const graph = new Graph<GraphNode>();
      graph.addNode('module.app.outputs.ip', { kind: 'output', scope: 'module.app', name: 'ip', value: undefined, context: new Address(['app'], '', '') });

      await executor.executeActionsSequentially([], graph, mockState, []);

      expect(resolveOutputsOf).toHaveBeenCalledWith('module.app', [], mockState);
    });
  });
});
