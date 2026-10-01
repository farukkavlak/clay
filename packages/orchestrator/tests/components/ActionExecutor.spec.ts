import { Address, CreateRequest, emptyState, ExactNumber, PlanRequest, Provider, Schema, State, UNKNOWN, UpdateRequest } from '@clay/contracts';
import { PlanAction } from '@clay/planner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionExecutor } from '../../src/components/ActionExecutor';
import { ResourcePlanner } from '../../src/components/ResourcePlanner';
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
  after: { tags: { a: UNKNOWN, b: 'x' } },
});

/** A create of a list the plan knew in part: its first item known, its second only the apply makes. */
const withList = (items: string[]): PlanAction => ({
  type: 'CREATE',
  resourceType: 'test',
  name: 'main',
  attributes: { l: { type: 'List', value: items.map((item) => str(item)), position: str('').position } },
  planned: { l: ['a', UNKNOWN] },
  after: { l: ['a', UNKNOWN] },
});

/** What the tests set, and what a provider makes of its own. */
const schema: Schema = {
  path: { type: 'string' },
  old: { type: 'string' },
  tags: { type: 'map' },
  l: { type: 'list', optional: true, computed: true },
  result: { type: 'string', computed: true },
  a: { type: 'string', computed: true },
  b: { type: 'string', computed: true },
  n: { type: 'number', computed: true },
};

/** A create of `path = "p"` whose provider planned `after`. */
const create = (after: Record<string, unknown>): PlanAction => ({
  type: 'CREATE',
  resourceType: 'test',
  name: 'main',
  attributes: { path: str('p') },
  planned: { path: 'p' },
  after,
});

const bug = 'test returned what the plan did not show, which is a bug in the provider:';

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
      create: vi.fn(async (_type: string, { config }: CreateRequest) => config),
      update: vi.fn(async (_type: string, { config }: UpdateRequest) => config),
      delete: vi.fn(),
      read: vi.fn(),
      getDataSourceSchema: vi.fn().mockResolvedValue({}),
      validateDataSource: vi.fn(),
      readDataSource: vi.fn(),
      getSchema: vi.fn(async () => schema),
      // Plans the configuration as it is set, unless a test says what else it plans.
      plan: vi.fn(async (_type: string, request: PlanRequest) => ({ after: request.config, replace: [] })),
    };

    providers = new ProviderRegistry();
    providers.register(mockProvider);
    const resolver = new ReferenceResolver(new ScopeManager(), new Map(), new Instances(), new ModuleInstances(), new Planned());
    executor = new ActionExecutor(providers, resolver, new ResourcePlanner(providers));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const context = Address.root('test', 'main');

  /** The plan at apply holds these, with what the configuration sets. */
  function plansAtApply(after: Record<string, unknown>, replace: (string | number)[][] = []): void {
    vi.mocked(mockProvider.plan).mockImplementationOnce(async (_type, request) => ({ after: { ...after, ...request.config }, replace }));
  }

  /** The next create returns these. */
  function created(attributes: Record<string, unknown>): void {
    vi.mocked(mockProvider.create).mockResolvedValueOnce(attributes);
  }

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
      mockState.resources[key] = { resourceType: 'test', name: 'main', attributes: {}, dependencies: ['test.old'] };
      const action: PlanAction = { type: 'NO_OP', resourceType: 'test', name: 'main', dependencies: ['test.new'] };

      await executor.execute(action, mockState);

      expect(mockProvider.create).not.toHaveBeenCalled();
      expect(mockProvider.update).not.toHaveBeenCalled();
      expect(mockProvider.delete).not.toHaveBeenCalled();
      expect(mockState.resources[key].dependencies).toEqual(['test.new']);
    });

    it('should execute a DELETE action and take the resource out of state', async () => {
      const key = context.toString();
      mockState.resources[key] = { resourceType: 'test', name: 'main', attributes: { id: 'existing-id' } };
      const action: PlanAction = {
        type: 'DELETE',
        resourceType: 'test',
        name: 'main',
      };

      await executor.execute(action, mockState);

      expect(mockProvider.delete).toHaveBeenCalledWith('test', { id: 'existing-id' });
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

    it('should write the new resource whole: its values and dependencies, and nothing copied from the ast', async () => {
      const action: PlanAction = {
        type: 'CREATE',
        resourceType: 'test',
        name: 'main',
        attributes: { path: str('p') },
        planned: { path: 'p' },
        after: { path: 'p' },
        dependencies: ['test.dep'],
      };

      await executor.executeCreate(action, mockProvider, mockState);

      expect(mockState.resources[context.toString()]).toEqual({
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
      };

      await expect(executor.executeUpdate(action, mockProvider, mockState)).rejects.toThrow('missing attributes');
    });

    it('refuses an update of a resource state does not hold', async () => {
      const action: PlanAction = {
        type: 'UPDATE',
        resourceType: 'test',
        name: 'missing',
        attributes: {},
        planned: {},
        after: {},
      };

      await expect(executor.executeUpdate(action, mockProvider, mockState)).rejects.toThrow('UPDATE of "test.missing", which state does not hold');
    });

    it('should send only the config attributes and drop the ones the config no longer sets', async () => {
      const key = context.toString();
      mockState.resources[key] = {
        resourceType: 'test',
        name: 'main',
        attributes: { old: 'val', dropped: 'val' },
      };

      const action: PlanAction = {
        type: 'UPDATE',
        resourceType: 'test',
        name: 'main',
        attributes: { old: str('updated') },
        planned: { old: 'updated' },
        after: { old: 'updated' },
      };

      await executor.executeUpdate(action, mockProvider, mockState);

      expect(mockProvider.update).toHaveBeenCalledWith('test', { prior: { old: 'val', dropped: 'val' }, config: { old: 'updated' }, planned: { old: 'updated' } });
      expect(mockState.resources[key].attributes).toEqual({ old: 'updated' });
    });

    it('should write the dependencies the action carries', async () => {
      const key = context.toString();
      mockState.resources[key] = { resourceType: 'test', name: 'main', attributes: {}, dependencies: ['test.old'] };
      const action: PlanAction = { type: 'UPDATE', resourceType: 'test', name: 'main', attributes: {}, planned: {}, after: {}, dependencies: ['test.dep'] };

      await executor.executeUpdate(action, mockProvider, mockState);

      expect(mockState.resources[key].dependencies).toEqual(['test.dep']);
    });
  });

  describe('holding to the plan', () => {
    it.each(['CREATE', 'UPDATE', 'REPLACE'] as const)('refuses a %s without the values it was planned with', async (type) => {
      mockState.resources[context.toString()] = { resourceType: 'test', name: 'main', attributes: {} };

      await expect(executor.execute({ type, resourceType: 'test', name: 'main', attributes: {} }, mockState)).rejects.toThrow(
        `${type} action missing the values it was planned with`
      );
    });

    // A replace deletes first, so a value off the plan found after the delete would leave nothing.
    it('leaves a resource to be replaced as it was when a value is off the plan', async () => {
      mockState.resources[context.toString()] = { resourceType: 'test', name: 'main', attributes: { path: 'old' } };
      const action: PlanAction = {
        type: 'REPLACE',
        resourceType: 'test',
        name: 'main',
        attributes: { path: str('other') },
        planned: { path: 'new' },
        after: { path: 'new' },
      };

      await expect(executor.execute(action, mockState)).rejects.toThrow('the plan showed path = "new", but it now comes to "other". Plan again.');
      expect(mockProvider.delete).not.toHaveBeenCalled();
      expect(mockProvider.create).not.toHaveBeenCalled();
    });

    it('runs a map known in part whose known part comes to what the plan showed', async () => {
      await executor.execute(withTags({ a: 'y', b: 'x' }), mockState);

      expect(mockProvider.create).toHaveBeenCalledWith('test', { config: { tags: { a: 'y', b: 'x' } }, planned: { tags: { a: 'y', b: 'x' } } });
    });

    it.each([
      ['a known part comes to another', { a: 'y', b: 'z' }, 'the plan showed tags = {"a":"(known after apply)","b":"x"}, but it now comes to {"a":"y","b":"z"}. Plan again.'],
      ['it has a key the plan did not', { a: 'y', b: 'x', c: 'w' }, 'but it now comes to {"a":"y","b":"x","c":"w"}'],
    ])('refuses a map known in part when %s', async (_, tags, refused) => {
      await expect(executor.execute(withTags(tags), mockState)).rejects.toThrow(refused);
    });

    it('runs a list known in part whose known items come to what the plan showed', async () => {
      await executor.execute(withList(['a', 'z']), mockState);

      expect(mockProvider.create).toHaveBeenCalledWith('test', { config: { l: ['a', 'z'] }, planned: { l: ['a', 'z'] } });
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
      const action: PlanAction = { type: 'CREATE', resourceType: 'test', name: 'main', attributes: { path: str('p') }, planned: {}, after: {} };

      await expect(executor.execute(action, mockState)).rejects.toThrow('the plan showed path = (none), but it now comes to "p". Plan again.');
    });
  });

  // The plan made at apply can know a value the first plan did not, so that is the one the provider is given.
  it('gives the provider what it planned at apply', async () => {
    plansAtApply({ result: 'r' });
    created({ path: 'p', result: 'r' });

    await executor.execute(create({ path: 'p', result: UNKNOWN }), mockState);

    expect(mockProvider.create).toHaveBeenCalledWith('test', { config: { path: 'p' }, planned: { path: 'p', result: 'r' } });
  });

  describe('holding what the apply returned to the plan', () => {
    it('stops a create that returns another value, and keeps what it made in state', async () => {
      created({ path: 'q' });

      await expect(executor.execute(create({ path: 'p' }), mockState)).rejects.toThrow(`${bug}\n  path = "q", where the plan showed "p"`);
      expect(mockState.resources[context.toString()]).toMatchObject({ attributes: { path: 'q' } });
    });

    it('stops an update that returns a value the plan did not have, and keeps what it returned in state', async () => {
      mockState.resources[context.toString()] = { resourceType: 'test', name: 'main', attributes: { path: 'old' } };
      vi.mocked(mockProvider.update).mockResolvedValueOnce({ path: 'p', extra: 1 });
      const action: PlanAction = {
        type: 'UPDATE',
        resourceType: 'test',
        name: 'main',
        attributes: { path: str('p') },
        planned: { path: 'p' },
        after: { path: 'p' },
      };

      await expect(executor.execute(action, mockState)).rejects.toThrow(`${bug}\n  extra = 1, which the plan did not have`);
      expect(mockState.resources[context.toString()].attributes).toEqual({ path: 'p', extra: 1 });
    });

    it('stops a replace whose create returns another value, and keeps the new resource in state', async () => {
      mockState.resources[context.toString()] = { resourceType: 'test', name: 'main', attributes: { path: 'old' } };
      created({ path: 'q' });

      await expect(executor.execute({ ...create({ path: 'p' }), type: 'REPLACE' }, mockState)).rejects.toThrow(bug);
      expect(mockState.resources[context.toString()]).toMatchObject({ attributes: { path: 'q' } });
    });

    it('holds a value the configuration sets to what it came to, where the plan did not know it', async () => {
      created({ path: 'q' });

      await expect(executor.execute(create({ path: UNKNOWN }), mockState)).rejects.toThrow(`${bug}\n  path = "q", where the plan showed "p"`);
    });

    it('takes any value where the plan did not know one the provider makes', async () => {
      plansAtApply({ result: UNKNOWN });
      created({ path: 'p', result: 'r' });

      await executor.execute(create({ path: 'p', result: UNKNOWN }), mockState);

      expect(mockState.resources[context.toString()].attributes).toEqual({ path: 'p', result: 'r' });
    });

    it.each([
      ['a value missing', { path: 'p' }, { result: 'r' }, 'result is missing, where the plan showed "r"'],
      ['a value not known', { path: 'p', result: UNKNOWN }, { result: 'r' }, 'result is not known; an apply returns every value'],
      ['an item of a list', { path: 'p', l: ['a', 'x'] }, { l: ['a', 'b'] }, 'l[1] = "x", where the plan showed "b"'],
      [
        'a number made in JavaScript',
        { path: 'p', n: 5 },
        { n: ExactNumber.parse('5') },
        'n = 5, where the plan showed 5 (a JavaScript number where the plan has an exact number)',
      ],
    ])('names %s', async (_, returned, planned, line) => {
      plansAtApply(planned);
      created(returned);

      await expect(executor.execute(create({ path: 'p', ...planned }), mockState)).rejects.toThrow(`${bug}\n  ${line}`);
    });

    it('names every value that differs', async () => {
      plansAtApply({ a: '1', b: '2' });
      created({ path: 'p', a: 'x', b: 'y' });

      await expect(executor.execute(create({ path: 'p', a: '1', b: '2' }), mockState)).rejects.toThrow(
        `${bug}\n  a = "x", where the plan showed "1"\n  b = "y", where the plan showed "2"`
      );
    });

    it.each(['CREATE', 'UPDATE', 'REPLACE'] as const)('refuses a %s without what its provider planned', async (type) => {
      mockState.resources[context.toString()] = { resourceType: 'test', name: 'main', attributes: {} };

      await expect(executor.execute({ type, resourceType: 'test', name: 'main', attributes: {}, planned: {} }, mockState)).rejects.toThrow(
        `${type} action missing what its provider planned`
      );
      expect(mockProvider.create).not.toHaveBeenCalled();
      expect(mockProvider.update).not.toHaveBeenCalled();
    });
  });

  describe('planning again at apply', () => {
    it('holds a create to what its provider plans once the values are known', async () => {
      plansAtApply({ result: 'r' });
      created({ path: 'p', result: 'x' });

      await expect(executor.execute(create({ path: 'p', result: UNKNOWN }), mockState)).rejects.toThrow(`${bug}\n  result = "x", where the plan showed "r"`);
    });

    it.each([
      ['another value', 's', 'result = "s", where the plan showed "r"'],
      ['no value known', UNKNOWN, 'result is not known, where the plan showed "r"'],
    ])('stops a replace before the delete when its provider plans %s where the plan knew one', async (_, result, line) => {
      mockState.resources[context.toString()] = { resourceType: 'test', name: 'main', attributes: { path: 'old' } };
      plansAtApply({ result });

      await expect(executor.execute({ ...create({ path: 'p', result: 'r' }), type: 'REPLACE' }, mockState)).rejects.toThrow(
        `test planned at apply what the plan did not show, which is a bug in the provider:\n  ${line}`
      );
      expect(mockProvider.delete).not.toHaveBeenCalled();
      expect(mockProvider.create).not.toHaveBeenCalled();
    });

    it('plans a replace again as a create, since the old resource goes', async () => {
      mockState.resources[context.toString()] = { resourceType: 'test', name: 'main', attributes: { path: 'old' } };

      await executor.execute({ ...create({ path: 'p' }), type: 'REPLACE' }, mockState);

      expect(mockProvider.plan).toHaveBeenCalledWith('test', { prior: null, proposed: { path: 'p' }, config: { path: 'p' } });
    });

    it('stops an update its provider plans at apply to replace', async () => {
      mockState.resources[context.toString()] = { resourceType: 'test', name: 'main', attributes: { path: 'old' } };
      plansAtApply({}, [['path']]);
      const action: PlanAction = { type: 'UPDATE', resourceType: 'test', name: 'main', attributes: { path: str('p') }, planned: { path: 'p' }, after: { path: 'p' } };

      await expect(executor.execute(action, mockState)).rejects.toThrow('test planned at apply to replace what the plan changed in place, which is a bug in the provider');
      expect(mockProvider.update).not.toHaveBeenCalled();
    });
  });

  describe('REPLACE', () => {
    it('should delete the old resource, create the new one and keep it in state', async () => {
      const key = context.toString();
      mockState.resources[key] = { resourceType: 'test', name: 'main', attributes: { path: 'old' } };
      const action: PlanAction = {
        type: 'REPLACE',
        resourceType: 'test',
        name: 'main',
        attributes: { path: str('new') },
        planned: { path: 'new' },
        after: { path: 'new' },
      };

      await executor.execute(action, mockState);

      expect(mockProvider.delete).toHaveBeenCalledWith('test', { path: 'old' });
      expect(mockProvider.create).toHaveBeenCalledWith('test', { config: { path: 'new' }, planned: { path: 'new' } });
      expect(mockState.resources[key]).toMatchObject({ attributes: { path: 'new' } });
    });

    // A value not known at plan was not checked then, so the check comes before the delete or a refused value would leave nothing.
    it('leaves the old resource as it was when the provider refuses the new values', async () => {
      const key = context.toString();
      mockState.resources[key] = { resourceType: 'test', name: 'main', attributes: { path: 'old' } };
      vi.mocked(mockProvider.validate).mockRejectedValueOnce(new Error('bad path'));
      const action: PlanAction = {
        type: 'REPLACE',
        resourceType: 'test',
        name: 'main',
        attributes: { path: str('new') },
        planned: { path: UNKNOWN },
        after: { path: UNKNOWN },
      };

      await expect(executor.execute(action, mockState)).rejects.toThrow('bad path');
      expect(mockProvider.delete).not.toHaveBeenCalled();
      expect(mockState.resources[key]).toMatchObject({ attributes: { path: 'old' } });
    });
  });

  describe('executeDelete', () => {
    it('refuses a delete of a resource state does not hold, and asks the provider nothing', async () => {
      const action: PlanAction = {
        type: 'DELETE',
        resourceType: 'test',
        name: 'main',
      };

      await expect(executor.executeDelete(action, mockProvider, mockState)).rejects.toThrow('DELETE of "test.main", which state does not hold');
      expect(mockProvider.delete).not.toHaveBeenCalled();
    });
  });
});
