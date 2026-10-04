import { ExactNumber, planFromSchema, PlannedChange, PlanRequest, Provider, Resource, Schema, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ResourcePlanner } from '../../src/components/ResourcePlanner';
import { ProviderRegistry } from '../../src/ProviderRegistry';
import { inferred, Value, valueOf } from '../../src/Value';

/** Values as the configuration writes them: a list a tuple and a map an object, with the type their items have. */
const written = (config: Record<string, unknown>): Record<string, Value> => Object.fromEntries(Object.entries(config).map(([name, data]) => [name, valueOf(inferred(data), data)]));

const schema: Schema = { path: { type: types.string, forceNew: true }, tags: { type: types.map(types.dynamic) }, made: { type: types.string, computed: true } };

/** Plans from the schema, unless a test gives it a plan of its own. */
function fakeProvider(plan: (request: PlanRequest) => PlannedChange = (request) => planFromSchema(schema, request)) {
  return {
    resources: ['thing'],
    dataSources: [],
    getSchema: async () => schema,
    validate: vi.fn(async () => {}),
    plan: vi.fn(async (_type: string, request: PlanRequest) => plan(request)),
    read: async () => null,
    getDataSourceSchema: async () => ({}),
    validateDataSource: async () => {},
    readDataSource: async () => ({}),
    create: async () => ({ id: 'x', attributes: {} }),
    update: async () => ({}),
    delete: async () => {},
  } satisfies Provider;
}

function plannerFor(provider: Provider): ResourcePlanner {
  const providers = new ProviderRegistry();
  providers.register(provider);

  return new ResourcePlanner(providers);
}

const current: Resource = { resourceType: 'thing', name: 'a', attributes: { path: 'a', tags: { x: '1' }, made: 'm' } };

describe('ResourcePlanner', () => {
  it('plans a change in place as its provider plans it', async () => {
    const config = { path: 'a', tags: { x: '2' } };

    expect(await plannerFor(fakeProvider()).plan('thing', schema, current, written(config))).toEqual({ after: { ...config, made: UNKNOWN }, replace: false, config });
  });

  it('plans a resource it replaces again, as one to create', async () => {
    const provider = fakeProvider();
    const config = { path: 'b', tags: { x: '1' } };

    const planned = await plannerFor(provider).plan('thing', schema, current, written(config));

    expect(planned).toEqual({ after: { ...config, made: UNKNOWN }, replace: true, config });
    expect(provider.plan).toHaveBeenLastCalledWith('thing', { prior: null, proposed: config, config });
  });

  // The provider is sent the values as the schema takes them, and so plans them, and the apply sends them again.
  it('sends the provider a value converted to the type the schema names, and gives it back', async () => {
    const provider = fakeProvider();
    const converted = { path: '5', tags: {} };

    const planned = await plannerFor(provider).plan('thing', schema, undefined, written({ path: ExactNumber.parse('5'), tags: {} }));

    expect(provider.validate).toHaveBeenCalledWith('thing', converted);
    expect(provider.plan).toHaveBeenCalledWith('thing', { prior: null, proposed: converted, config: converted });
    expect(planned).toEqual({ after: { ...converted, made: UNKNOWN }, replace: false, config: converted });
  });

  it('replaces only where a value the provider names changes', async () => {
    const provider = fakeProvider((request) => ({ ...planFromSchema(schema, request), replace: [['path']] }));

    expect(await plannerFor(provider).plan('thing', schema, current, written({ path: 'a', tags: { x: '2' } }))).toMatchObject({ replace: false });
  });

  it.each([
    ['changes', { x: '2' }, true],
    ['stays the same beside a change', { x: '1', y: '2' }, false],
  ])('replaces where a value inside an attribute %s', async (_, tags, replace) => {
    const provider = fakeProvider((request) => ({ ...planFromSchema(schema, request), replace: [['tags', 'x']] }));

    expect(await plannerFor(provider).plan('thing', schema, current, written({ path: 'a', tags }))).toMatchObject({ replace });
  });

  it.each([
    ['changes', (after: Record<string, unknown>) => ({ ...after, path: 'cleaned' }), 'thing planned path = "cleaned", but the configuration sets "a"'],
    ['leaves out', ({ path: _, ...after }: Record<string, unknown>) => after, 'thing planned path = (none), but the configuration sets "a"'],
  ])('refuses a plan that %s a value the configuration sets', async (_, change, message) => {
    const provider = fakeProvider((request) => ({ after: change(planFromSchema(schema, request).after), replace: [] }));

    await expect(plannerFor(provider).plan('thing', schema, undefined, written({ path: 'a' }))).rejects.toThrow(message);
  });

  it('refuses a plan with a value the configuration does not set and the provider does not compute', async () => {
    const provider = fakeProvider((request) => ({ after: { ...request.proposed, extra: 'x' }, replace: [] }));

    await expect(plannerFor(provider).plan('thing', schema, undefined, written({ path: 'a' }))).rejects.toThrow(
      'thing planned extra, which the configuration does not set and thing does not compute'
    );
  });

  describe('a value kept until the resource is replaced', () => {
    const keeping: Schema = { ...schema, serial: { type: types.string, computed: true, kept: true } };
    const held: Resource = { ...current, attributes: { ...current.attributes, serial: 's' } };
    const remaking = (request: PlanRequest) => ({ after: { ...planFromSchema(keeping, request).after, serial: UNKNOWN }, replace: [] });

    it('refuses a provider that plans it as not known on a change in place', async () => {
      await expect(plannerFor(fakeProvider(remaking)).plan('thing', keeping, held, written({ path: 'a', tags: { x: '2' } }))).rejects.toThrow(
        'thing planned serial as known after apply on a change in place, though it keeps it until it is replaced, which is a bug in the provider'
      );
    });

    it('takes it as not known on a replacement, which makes it again', async () => {
      const provider = fakeProvider((request) => ({ ...remaking(request), replace: [['path']] }));

      expect(await plannerFor(provider).plan('thing', keeping, held, written({ path: 'b', tags: { x: '1' } }))).toMatchObject({ after: { serial: UNKNOWN }, replace: true });
    });
  });

  it('checks the values with the provider before it asks for a plan', async () => {
    const provider = fakeProvider();
    provider.validate.mockRejectedValue(new Error('path is wrong'));

    await expect(plannerFor(provider).plan('thing', schema, undefined, written({ path: 'a' }))).rejects.toThrow('path is wrong');
    expect(provider.plan).not.toHaveBeenCalled();
  });

  it('asks the provider to check a value not known yet, as it is', async () => {
    const provider = fakeProvider();

    await plannerFor(provider).plan('thing', schema, undefined, written({ path: 'a', tags: { x: UNKNOWN } }));

    expect(provider.validate).toHaveBeenCalledWith('thing', { path: 'a', tags: { x: UNKNOWN } });
    expect(provider.plan).toHaveBeenCalled();
  });
});
