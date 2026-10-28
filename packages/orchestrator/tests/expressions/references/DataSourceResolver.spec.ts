import { Address, ModuleAddress, Schema, types } from '@clay/contracts';
import { DataReference, parseReference } from '@clay/parser';
import { describe, expect, it } from 'vitest';

import { Instances } from '../../../src/instances/Instances';
import { DataInstance } from '../../../src/keys';
import { DataSourceReader } from '../../../src/plan/DataSourceReader';
import { Limit } from '../../../src/providers/Limit';
import { ProviderRegistry } from '../../../src/providers/ProviderRegistry';
import { DEFAULT_PARALLELISM } from '../../../src/run/parallelism';
import { Value, valueOf } from '../../../src/values/Value';
import { Versions } from '../../../src/values/Versions';
import { DataSourceResolver } from '../../../src/expressions/references/DataSourceResolver';
import { steps } from '../../ast';

const ref = (spelled: string) => parseReference(steps(...spelled.split('.'))) as DataReference;

const context = Address.root('resource', 'main');
const schemas = new Map<string, Schema>([['src', { v: { type: types.string } }]]);

/** `data.src.s` with `count = 2` in a module instance, read through a reader that keeps what a plan read. */
const counted = (module = ModuleAddress.root) => {
  const dataSources = new Map<string, Record<string, Value>>();
  const instances = new Instances();
  const versions = new Versions();
  instances.declare(new DataInstance(module.withoutKeys(), 'src', 's').block, 'count');
  instances.setCount(new DataInstance(module, 'src', 's').block, 2);
  const reader = new DataSourceReader(new ProviderRegistry(), schemas, dataSources, versions, new Limit(DEFAULT_PARALLELISM));
  const keep = (key: number, v: string) => reader.use(new DataInstance(module, 'src', 's', key), { v: { type: types.string, value: v } });
  keep(0, 'zero');
  keep(1, 'one');

  return { instances, keep, resolver: new DataSourceResolver(dataSources, schemas, instances, versions) };
};

describe('DataSourceResolver', () => {
  describe('every instance', () => {
    it('reads every instance once for all that read it', () => {
      const { resolver } = counted();

      expect(resolver.resolve(ref('data.src.s'), context).value).toBe(resolver.resolve(ref('data.src.s'), context).value);
    });

    it('reads every instance again once one of them is read again', () => {
      const { keep, resolver } = counted();
      resolver.resolve(ref('data.src.s'), context);

      keep(1, 'again');

      expect(resolver.resolve(ref('data.src.s'), context).value).toEqual(valueOf(types.list(types.object({ v: types.string })), [{ v: 'zero' }, { v: 'again' }]));
    });

    it('reads every instance again in a module instance once one of them is read again', () => {
      const app = ModuleAddress.root.child('app', 1);
      const { keep, resolver } = counted(app);
      const inApp = new Address(app, 'resource', 'main');
      resolver.resolve(ref('data.src.s'), inApp);

      keep(1, 'again');

      expect(resolver.resolve(ref('data.src.s'), inApp).value.data).toEqual([{ v: 'zero' }, { v: 'again' }]);
    });

    it('reads every instance again once its count is read again', () => {
      const { instances, resolver } = counted();
      resolver.resolve(ref('data.src.s'), context);

      instances.setCount('data:src.s', 1);

      expect(resolver.resolve(ref('data.src.s'), context).value.data).toEqual([{ v: 'zero' }]);
    });
  });
});
