import { describe, expect, it } from 'vitest';

import { planFromSchema, Schema, UNKNOWN } from '../src/index';

const schema: Schema = {
  path: { type: 'string', forceNew: true },
  content: { type: 'string' },
  made: { type: 'string', computed: true },
  label: { type: 'string', computed: true, optional: true },
};

describe('planFromSchema', () => {
  it('plans what the provider computes for a resource to create as known after apply, and what the configuration sets as set', () => {
    const config = { path: 'a', label: 'set' };

    expect(planFromSchema(schema, { prior: null, proposed: config, config })).toEqual({ after: { path: 'a', label: 'set', made: UNKNOWN }, replace: [] });
  });

  it('keeps a resource that does not change as it was read', () => {
    const prior = { path: 'a', content: 'x', made: 'm', label: 'l' };

    expect(planFromSchema(schema, { id: 'i', prior, proposed: { ...prior }, config: { path: 'a', content: 'x' } })).toEqual({ after: prior, replace: [] });
  });

  it('makes what the provider computes again when anything changes, and keeps what the configuration sets', () => {
    const prior = { path: 'a', content: 'x', made: 'm', label: 'l' };
    const config = { path: 'a', content: 'y', label: 'l' };

    expect(planFromSchema(schema, { id: 'i', prior, proposed: { ...config, made: 'm' }, config })).toEqual({
      after: { path: 'a', content: 'y', label: 'l', made: UNKNOWN },
      replace: [],
    });
  });

  it.each([
    ['changes', 'b'],
    ['is not known yet', UNKNOWN],
  ])('replaces the resource where a forceNew value %s', (_, path) => {
    const config = { path, content: 'x' };

    expect(planFromSchema(schema, { id: 'i', prior: { path: 'a', content: 'x' }, proposed: config, config }).replace).toEqual([['path']]);
  });

  it('names no forceNew value that stays the same', () => {
    const config = { path: 'a', content: 'y' };

    expect(planFromSchema(schema, { id: 'i', prior: { path: 'a', content: 'x' }, proposed: config, config }).replace).toEqual([]);
  });
});
