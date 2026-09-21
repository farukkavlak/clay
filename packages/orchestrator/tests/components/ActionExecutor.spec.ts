import { Address, Provider, State } from '@clay/contracts';
import { PlanAction } from '@clay/planner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionExecutor } from '../../src/components/ActionExecutor';
import { ProviderRegistry } from '../../src/ProviderRegistry';
import { ReferenceResolver } from '../../src/resolvers/ReferenceResolver';
import { ScopeManager } from '../../src/scope/ScopeManager';
import { str } from '../ast';

describe('ActionExecutor', () => {
  let providers: ProviderRegistry;
  let executor: ActionExecutor;
  let mockProvider: Provider;

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

    providers = new ProviderRegistry();
    providers.register(mockProvider);
    executor = new ActionExecutor(providers, new ReferenceResolver(new ScopeManager(), new Map()));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const mockState: State = {
    version: 1,
    serial: 0,
    resources: {},
  };

  const context = new Address([], 'test', 'main');

  describe('execute', () => {
    it('should throw if provider not found', async () => {
      const action: PlanAction = {
        type: 'CREATE',
        resourceType: 'unknown',
        name: 'main',
        attributes: {},
      };

      await expect(executor.execute(action, mockState)).rejects.toThrow('No provider handles');
    });

    it('should throw on unknown action type', async () => {
      const action = {
        type: 'UNKNOWN',
        resourceType: 'test',
        name: 'main',
        attributes: {},
      };

      // An action type the plan never produces, so the type is forced.
      await expect(executor.execute(action as unknown as PlanAction, mockState)).rejects.toThrow('Unknown action type');
    });

    it('should only refresh the dependencies on a NO_OP action', async () => {
      const key = context.toString();
      mockState.resources[key] = { id: 'existing', resourceType: 'test', name: 'main', attributes: {}, dependencies: ['test.old'] };
      const action: PlanAction = { type: 'NO_OP', resourceType: 'test', name: 'main', dependencies: ['test.new'] };

      await executor.execute(action, mockState);

      expect(mockProvider.create).not.toHaveBeenCalled();
      expect(mockProvider.update).not.toHaveBeenCalled();
      expect(mockProvider.delete).not.toHaveBeenCalled();
      expect(mockState.resources[key].dependencies).toEqual(['test.new']);
    });

    it('should execute a DELETE action', async () => {
      const action: PlanAction = {
        type: 'DELETE',
        resourceType: 'test',
        name: 'main',
        id: 'existing-id',
      };

      await executor.execute(action, mockState);
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

    it('should write the new resource whole: its id, values and dependencies, and nothing copied from the ast', async () => {
      const action: PlanAction = { type: 'CREATE', resourceType: 'test', name: 'main', attributes: { path: str('p') }, dependencies: ['test.dep'] };

      await executor.executeCreate(action, mockProvider, mockState);

      expect(mockState.resources[context.toString()]).toEqual({
        id: 'created-id',
        resourceType: 'test',
        name: 'main',
        modulePath: [],
        attributes: { path: 'p' },
        dependencies: ['test.dep'],
      });
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
        resourceType: 'test',
        name: 'main',
        attributes: { old: 'val', dropped: 'val' },
      };

      const action: PlanAction = {
        type: 'UPDATE',
        resourceType: 'test',
        name: 'main',
        id: 'existing',
        attributes: { old: str('updated') },
      };

      await executor.executeUpdate(action, mockProvider, mockState);

      expect(mockProvider.update).toHaveBeenCalledWith('existing', 'test', { old: 'updated' });
      expect(mockState.resources[key].attributes).toEqual({ old: 'updated' });
    });

    it('should write the dependencies the action carries', async () => {
      const key = context.toString();
      mockState.resources[key] = { id: 'existing', resourceType: 'test', name: 'main', attributes: {}, dependencies: ['test.old'] };
      const action: PlanAction = { type: 'UPDATE', resourceType: 'test', name: 'main', id: 'existing', attributes: {}, dependencies: ['test.dep'] };

      await executor.executeUpdate(action, mockProvider, mockState);

      expect(mockState.resources[key].dependencies).toEqual(['test.dep']);
    });
  });

  describe('REPLACE', () => {
    it('should delete the old resource, create the new one and keep it in state', async () => {
      const key = context.toString();
      mockState.resources[key] = { id: 'old', resourceType: 'test', name: 'main', attributes: { path: 'old' } };
      const action: PlanAction = { type: 'REPLACE', resourceType: 'test', name: 'main', id: 'old', attributes: { path: str('new') } };

      await executor.execute(action, mockState);

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
});
