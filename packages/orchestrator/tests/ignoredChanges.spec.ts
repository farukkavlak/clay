import { Resource, Schema, types, UNKNOWN } from '@clay/contracts';
import { describe, expect, it } from 'vitest';

import { ignoredPaths, keepPrior } from '../src/ignoredChanges';

const prior = (attributes: Record<string, unknown>, sensitive?: (string | number)[][]): Resource => ({
  resourceType: 'mock',
  name: 'r',
  attributes,
  ...(sensitive && { sensitive }),
});

describe('ignoredPaths', () => {
  const schema: Schema = {
    id: { type: types.string, computed: true },
    path: { type: types.string, required: true },
    note: { type: types.string, computed: true, optional: true },
  };

  it('is the paths as written, none where nothing is ignored', () => {
    expect(ignoredPaths([{ path: ['path'], position: { file: 'main.clay', line: 1, column: 1 } }], schema)).toEqual([['path']]);
    expect(ignoredPaths(undefined, schema)).toEqual([]);
  });

  it('is every attribute the configuration can set for all, and none the provider alone computes', () => {
    expect(ignoredPaths('all', schema)).toEqual([['path'], ['note']]);
  });
});

describe('keepPrior', () => {
  it('puts back the value the prior held at a path', () => {
    const kept = keepPrior({ a: 'new', b: 'new' }, [], prior({ a: 'old', b: 'old' }), [['a']]);

    expect(kept.config).toEqual({ a: 'old', b: 'new' });
  });

  it('drops a value the prior never held, and keeps a null it did', () => {
    expect(keepPrior({ a: 'new' }, [], prior({}), [['a']]).config).toEqual({});
    expect(keepPrior({ a: 'new' }, [], prior({ a: null }), [['a']]).config).toEqual({ a: null });
  });

  it('reaches a key of a map, and leaves the others', () => {
    const kept = keepPrior({ tags: { a: '2', b: '2' } }, [], prior({ tags: { a: '1', b: '1' } }), [['tags', 'a']]);

    expect(kept.config).toEqual({ tags: { a: '1', b: '2' } });
  });

  it('drops a key the prior had none of, and makes the map where the configuration has none', () => {
    expect(keepPrior({ tags: { a: '2' } }, [], prior({ tags: {} }), [['tags', 'a']]).config).toEqual({ tags: {} });
    expect(keepPrior({}, [], prior({ tags: { a: '1' } }), [['tags', 'a']]).config).toEqual({ tags: { a: '1' } });
    expect(keepPrior({}, [], prior({}), [['tags', 'a']]).config).toEqual({});
  });

  it('reaches an item of a list: put back, dropped where the prior has none, added where the configuration is short', () => {
    expect(keepPrior({ items: ['x', 'new'] }, [], prior({ items: ['x', 'old'] }), [['items', 1]]).config).toEqual({ items: ['x', 'old'] });
    expect(keepPrior({ items: ['x', 'new'] }, [], prior({ items: ['x'] }), [['items', 1]]).config).toEqual({ items: ['x'] });
    expect(keepPrior({ items: ['x'] }, [], prior({ items: ['x', 'old'] }), [['items', 1]]).config).toEqual({ items: ['x', 'old'] });
  });

  it('leaves a value not known yet whole where a key or an index below it is named', () => {
    expect(keepPrior({ tags: UNKNOWN }, [], prior({ tags: { a: '1', b: '2' } }), [['tags', 'a']]).config).toEqual({ tags: UNKNOWN });
    expect(keepPrior({ items: UNKNOWN }, [], prior({ items: ['x'] }), [['items', 0]]).config).toEqual({ items: UNKNOWN });
  });

  it('takes the whole of a value not known yet back where its own path is named', () => {
    expect(keepPrior({ tags: UNKNOWN }, [], prior({ tags: { a: '1' } }), [['tags']]).config).toEqual({ tags: { a: '1' } });
  });

  it('reads each path against the list as the paths before it left it, so an item dropped moves the ones after it', () => {
    const kept = keepPrior({ items: [1, 2, 3] }, [], prior({ items: [1] }), [
      ['items', 0],
      ['items', 1],
    ]);

    expect(kept.config).toEqual({ items: [1, 3] });
  });

  it('leaves a value that is not a list where an index is named', () => {
    expect(keepPrior({ items: 'text' }, [], prior({ items: ['old'] }), [['items', 0]]).config).toEqual({ items: 'text' });
  });

  it('changes nothing for no path, and does not change what it was given', () => {
    const config = { a: { b: 'new' } };
    const kept = keepPrior(config, [['a']], prior({ a: { b: 'old' } }), [['a', 'b']]);

    expect(keepPrior(config, [['a']], prior({}), []).config).toBe(config);
    expect(config).toEqual({ a: { b: 'new' } });
    expect(kept.config).toEqual({ a: { b: 'old' } });
  });

  describe('which parts are sensitive', () => {
    it('takes the prior marks under an ignored path and the configuration marks elsewhere', () => {
      const kept = keepPrior({ a: 'new', b: 'new' }, [['a'], ['b']], prior({ a: 'old', b: 'old' }, [['a'], ['c']]), [['a'], ['c']]);

      expect(kept.sensitive).toEqual([['b'], ['a'], ['c']]);
    });

    it('drops a mark the configuration put under an ignored path and the prior lacked', () => {
      expect(keepPrior({ a: 'new' }, [['a']], prior({ a: 'old' }), [['a']]).sensitive).toEqual([]);
    });

    it('takes a mark deeper than the ignored path with it', () => {
      const kept = keepPrior({ a: { x: 'new' } }, [['a', 'x']], prior({ a: { x: 'old' } }), [['a']]);

      expect(kept.sensitive).toEqual([]);
    });

    it('keeps a mark on the whole attribute where only a part of it is ignored', () => {
      expect(keepPrior({ a: { b: 'new' } }, [['a']], prior({ a: { b: 'old' } }), [['a', 'b']]).sensitive).toEqual([['a']]);
    });
  });
});
