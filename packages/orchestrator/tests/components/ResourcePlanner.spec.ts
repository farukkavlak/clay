import { planFromSchema, PlannedChange, PlanRequest, Provider, Resource, Schema, UNKNOWN } from '@clay/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ResourcePlanner } from '../../src/components/ResourcePlanner';
import { ProviderRegistry } from '../../src/ProviderRegistry';

const schema: Schema = { path: { type: 'string', forceNew: true }, tags: { type: 'map' }, made: { type: 'string', computed: true } };

/** Plans from the schema, unless a test gives it a plan of its own. */
function fakeProvider(plan: (request: PlanRequest) => PlannedChange = (request) => planFromSchema(schema, request)) {
  return {
    resources: ['thing'],
    dataSources: [],
    getSchema: async () => schema,
    validate: vi.fn(async () => {}),
    plan: vi.fn(async (_type: string, request: PlanRequest) => plan(request)),
    read: async () => null,
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

    expect(await plannerFor(fakeProvider()).plan('thing', schema, current, config)).toEqual({ after: { ...config, made: UNKNOWN }, replace: false });
  });

  it('plans a resource it replaces again, as one to create', async () => {
    const provider = fakeProvider();
    const config = { path: 'b', tags: { x: '1' } };

    const planned = await plannerFor(provider).plan('thing', schema, current, config);

    expect(planned).toEqual({ after: { ...config, made: UNKNOWN }, replace: true });
    expect(provider.plan).toHaveBeenLastCalledWith('thing', { prior: null, proposed: config, config });
  });

  it('replaces only where a value the provider names changes', async () => {
    const provider = fakeProvider((request) => ({ ...planFromSchema(schema, request), replace: [['path']] }));

    expect(await plannerFor(provider).plan('thing', schema, current, { path: 'a', tags: { x: '2' } })).toMatchObject({ replace: false });
  });

  it.each([
    ['changes', { x: '2' }, true],
    ['stays the same beside a change', { x: '1', y: '2' }, false],
  ])('replaces where a value inside an attribute %s', async (_, tags, replace) => {
    const provider = fakeProvider((request) => ({ ...planFromSchema(schema, request), replace: [['tags', 'x']] }));

    expect(await plannerFor(provider).plan('thing', schema, current, { path: 'a', tags })).toMatchObject({ replace });
  });

  it.each([
    ['changes', (after: Record<string, unknown>) => ({ ...after, path: 'cleaned' }), 'thing planned path = "cleaned", but the configuration sets "a"'],
    ['leaves out', ({ path: _, ...after }: Record<string, unknown>) => after, 'thing planned path = (none), but the configuration sets "a"'],
  ])('refuses a plan that %s a value the configuration sets', async (_, change, message) => {
    const provider = fakeProvider((request) => ({ after: change(planFromSchema(schema, request).after), replace: [] }));

    await expect(plannerFor(provider).plan('thing', schema, undefined, { path: 'a' })).rejects.toThrow(message);
  });

  it('refuses a plan with a value the configuration does not set and the provider does not compute', async () => {
    const provider = fakeProvider((request) => ({ after: { ...request.proposed, extra: 'x' }, replace: [] }));

    await expect(plannerFor(provider).plan('thing', schema, undefined, { path: 'a' })).rejects.toThrow(
      'thing planned extra, which the configuration does not set and thing does not compute'
    );
  });

  it('checks the values with the provider before it asks for a plan', async () => {
    const provider = fakeProvider();
    provider.validate.mockRejectedValue(new Error('path is wrong'));

    await expect(plannerFor(provider).plan('thing', schema, undefined, { path: 'a' })).rejects.toThrow('path is wrong');
    expect(provider.plan).not.toHaveBeenCalled();
  });

  it('plans a value not known yet without checking it', async () => {
    const provider = fakeProvider();

    await plannerFor(provider).plan('thing', schema, undefined, { path: 'a', tags: { x: UNKNOWN } });

    expect(provider.validate).not.toHaveBeenCalled();
    expect(provider.plan).toHaveBeenCalled();
  });
});
