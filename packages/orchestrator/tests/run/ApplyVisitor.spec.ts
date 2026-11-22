import { ModuleAddress, State, STATE_VERSION } from '@clay/core';
import { describe, expect, it } from 'vitest';

import { ScopeManager } from '../../src/config/ScopeManager';
import { InstanceKeys } from '../../src/expressions/references/InstanceKeys';
import { ReferenceResolver } from '../../src/expressions/ReferenceResolver';
import { GraphNode } from '../../src/graph/nodes';
import { Instances } from '../../src/instances/Instances';
import { ModuleInstances } from '../../src/instances/ModuleInstances';
import { DataSourceReader } from '../../src/plan/DataSourceReader';
import { Limit } from '../../src/providers/Limit';
import { ProviderInstances } from '../../src/providers/ProviderInstances';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry';
import { Applying, ApplyVisitor } from '../../src/run/ApplyVisitor';
import { DEFAULT_PARALLELISM } from '../../src/run/parallelism';
import { Planned } from '../../src/values/Planned';
import { Value } from '../../src/values/Value';
import { Versions } from '../../src/values/Versions';
import { str } from '../ast';
import { schemasOf, tableOf } from '../schemas';

const position = { file: 'main.clay', line: 1, column: 1 };
const state: State = { version: STATE_VERSION, serial: 0, resources: {} };

function visitor(): ApplyVisitor {
  const versions = new Versions();
  const scopes = new ScopeManager(versions);
  const instances = new Instances();
  const modules = new ModuleInstances();
  const dataSources = new Map<string, Record<string, Value>>();
  const limit = new Limit(DEFAULT_PARALLELISM);
  const providers = new ProviderInstances(new ProviderRegistry(), tableOf([], 'provider'), limit);
  const resolver = new ReferenceResolver(scopes, dataSources, schemasOf(), instances, modules, new Planned(versions), new InstanceKeys(instances, modules), versions, 'default');

  return new ApplyVisitor(scopes, resolver, instances, modules, new DataSourceReader(providers, tableOf([], 'data source'), dataSources, versions, limit), providers);
}

const output: GraphNode = {
  kind: 'output',
  name: 'o',
  value: str('a'),
  declared: {},
  module: ModuleAddress.root,
  context: ModuleAddress.root,
  position,
  declaration: 'output "o"',
};

const applying = (): Applying => ({
  named: new Map(),
  outputs: new Map(),
  read: { imported: {}, dataSources: {}, readAtApply: [] },
  byBlock: new Map(),
  declared: ['o'],
  resolved: new Map(),
});

describe('ApplyVisitor', () => {
  it('says it is a bug where a root output has nothing in the plan to check it against', async () => {
    const visit = visitor().visit('output.o', output, applying(), state);

    await expect(visit.next()).rejects.toThrow(new Error('the plan has no output "o" to check it against, which is a bug'));
  });
});
