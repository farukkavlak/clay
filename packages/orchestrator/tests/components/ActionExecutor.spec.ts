import { Address, emptyState, Provider, State } from '@clay/contracts';
import { PlanAction, UNKNOWN } from '@clay/planner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionExecutor } from '../../src/components/ActionExecutor';
import { ModuleInstances } from '../../src/ModuleInstances';
import { Planned } from '../../src/Planned';
import { ProviderRegistry } from '../../src/ProviderRegistry';
import { Instances } from '../../src/Instances';
import { ReferenceResolver } from '../../src/resolvers/ReferenceResolver';
import { ScopeManager } from '../../src/scope/ScopeManager';
import { str } from '../ast';

/** A create of a map the plan knew in part: `a` only the apply makes, `b` known. */
const withTags = (tags: Record<string, string>): PlanAction => ({
  type: 'CREATE',
  resourceType: 'test',
  name: 'main',
  attributes: { tags: { type: 'Map', value: Object.fromEntries(Object.entries(tags).map(([key, value]) => [key, str(value)])), position: str('').position } },
  planned: { tags: { a: UNKNOWN, b: 'x' } },
});

/** A create of a list the plan knew in part: its first item known, its second only the apply makes. */
const withList = (items: string[]): PlanAction => ({
  type: 'CREATE',
  resourceType: 'test',
  name: 'main',
  attributes: { l: { type: 'List', value: items.map((item) => str(item)), position: str('').position } },
  planned: { l: ['a', UNKNOWN] },
});

describe('ActionExecutor', () => {
  let providers: ProviderRegistry;
  let executor: ActionExecutor;
  let mockProvider: Provider;
  let mockState: State;

  beforeEach(() => {
    mockState = emptyState();
    mockProvider = {
      resources: ['test'],
      dataSources: [],
      validate: vi.fn(),
      create: vi.fn(async (_type: string, inputs: Record<string, unknown>) => ({ id: 'created-id', attributes: inputs })),
      update: vi.fn(async (_id: string, _type: string, inputs: Record<string, unknown>) => inputs),
      delete: vi.fn(),
      read: vi.fn(),
      validateDataSource: vi.fn(),
      readDataSource: vi.fn(),
      getSchema: vi.fn(),
    };

    providers = new ProviderRegistry();
    providers.register(mockProvider);
    executor = new ActionExecutor(providers, new ReferenceResolver(new ScopeManager(), new Map(), new Instances(), new ModuleInstances(), new Planned()));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const context = Address.root('test', 'main');

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

    it('should execute a DELETE action and take the resource out of state', async () => {
      const key = context.toString();
      mockState.resources[key] = { id: 'existing-id', resourceType: 'test', name: 'main', attributes: {} };
      const action: PlanAction = {
        type: 'DELETE',
        resourceType: 'test',
        name: 'main',
        id: 'existing-id',
      };

      await executor.execute(action, mockState);

      expect(mockProvider.delete).toHaveBeenCalledWith('existing-id', 'test');
      expect(mockState.resources[key]).toBeUndefined();
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
      const action: PlanAction = { type: 'CREATE', resourceType: 'test', name: 'main', attributes: { path: str('p') }, planned: { path: 'p' }, dependencies: ['test.dep'] };

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
        planned: {},
      };

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
        planned: {},
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
        planned: { old: 'updated' },
      };

      await executor.executeUpdate(action, mockProvider, mockState);

      expect(mockProvider.update).toHaveBeenCalledWith('existing', 'test', { old: 'updated' });
      expect(mockState.resources[key].attributes).toEqual({ old: 'updated' });
    });

    it('should write the dependencies the action carries', async () => {
      const key = context.toString();
      mockState.resources[key] = { id: 'existing', resourceType: 'test', name: 'main', attributes: {}, dependencies: ['test.old'] };
      const action: PlanAction = { type: 'UPDATE', resourceType: 'test', name: 'main', id: 'existing', attributes: {}, planned: {}, dependencies: ['test.dep'] };

      await executor.executeUpdate(action, mockProvider, mockState);

      expect(mockState.resources[key].dependencies).toEqual(['test.dep']);
    });
  });

  describe('holding to the plan', () => {
    it.each(['CREATE', 'UPDATE', 'REPLACE'] as const)('refuses a %s without the values it was planned with', async (type) => {
      mockState.resources[context.toString()] = { id: 'old', resourceType: 'test', name: 'main', attributes: {} };

      await expect(executor.execute({ type, resourceType: 'test', name: 'main', id: 'old', attributes: {} }, mockState)).rejects.toThrow(
        `${type} action missing the values it was planned with`
      );
    });

    // A replace deletes first, so a value off the plan found after the delete would leave nothing.
    it('leaves a resource to be replaced as it was when a value is off the plan', async () => {
      mockState.resources[context.toString()] = { id: 'old', resourceType: 'test', name: 'main', attributes: { path: 'old' } };
      const action: PlanAction = { type: 'REPLACE', resourceType: 'test', name: 'main', id: 'old', attributes: { path: str('other') }, planned: { path: 'new' } };

      await expect(executor.execute(action, mockState)).rejects.toThrow('the plan showed path = "new", but it now comes to "other". Plan again.');
      expect(mockProvider.delete).not.toHaveBeenCalled();
      expect(mockProvider.create).not.toHaveBeenCalled();
    });

    it('runs a map known in part whose known part comes to what the plan showed', async () => {
      await executor.execute(withTags({ a: 'y', b: 'x' }), mockState);

      expect(mockProvider.create).toHaveBeenCalledWith('test', { tags: { a: 'y', b: 'x' } });
    });

    it.each([
      ['a known part comes to another', { a: 'y', b: 'z' }, 'the plan showed tags = {"a":"(known after apply)","b":"x"}, but it now comes to {"a":"y","b":"z"}. Plan again.'],
      ['it has a key the plan did not', { a: 'y', b: 'x', c: 'w' }, 'but it now comes to {"a":"y","b":"x","c":"w"}'],
    ])('refuses a map known in part when %s', async (_, tags, refused) => {
      await expect(executor.execute(withTags(tags), mockState)).rejects.toThrow(refused);
    });

    it('runs a list known in part whose known items come to what the plan showed', async () => {
      await executor.execute(withList(['a', 'z']), mockState);

      expect(mockProvider.create).toHaveBeenCalledWith('test', { l: ['a', 'z'] });
    });

    it.each([
      ['a known item comes to another', ['b', 'z']],
      ['it holds more items than the plan did', ['a', 'z', 'q']],
    ])('refuses a list known in part when %s', async (_, items) => {
      await expect(executor.execute(withList(items), mockState)).rejects.toThrow(
        `the plan showed l = ["a","(known after apply)"], but it now comes to ${JSON.stringify(items)}. Plan again.`
      );
    });

    it('refuses a value the plan did not have', async () => {
      const action: PlanAction = { type: 'CREATE', resourceType: 'test', name: 'main', attributes: { path: str('p') }, planned: {} };

      await expect(executor.execute(action, mockState)).rejects.toThrow('the plan showed path = (none), but it now comes to "p". Plan again.');
    });
  });

  describe('REPLACE', () => {
    it('should delete the old resource, create the new one and keep it in state', async () => {
      const key = context.toString();
      mockState.resources[key] = { id: 'old', resourceType: 'test', name: 'main', attributes: { path: 'old' } };
      const action: PlanAction = { type: 'REPLACE', resourceType: 'test', name: 'main', id: 'old', attributes: { path: str('new') }, planned: { path: 'new' } };

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
