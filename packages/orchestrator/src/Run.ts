import { Schema } from '@clay/contracts';
import { StateManager } from '@clay/state';

import { ActionExecutor } from './components/ActionExecutor';
import { ConfigLoader } from './components/ConfigLoader';
import { DataSourceReader } from './components/DataSourceReader';
import { DependencyGraphBuilder } from './components/DependencyGraphBuilder';
import { DesiredStateBuilder } from './components/DesiredStateBuilder';
import { ModuleLoader } from './components/ModuleLoader';
import { PlanRunner } from './components/PlanRunner';
import { ResourcePlanner } from './components/ResourcePlanner';
import { WrittenCheck } from './components/WrittenCheck';
import { ConfigFiles } from './ConfigFiles';
import { Instances } from './Instances';
import { ModuleInstances } from './ModuleInstances';
import { Planned } from './Planned';
import { ProviderRegistry } from './ProviderRegistry';
import { InstanceKeys } from './resolvers/InstanceKeys';
import { ReferenceResolver } from './resolvers/ReferenceResolver';
import { ReferenceScanner } from './resolvers/ReferenceScanner';
import { SameObjects } from './sameObject';
import { ScopeManager } from './scope/ScopeManager';
import { Value } from './Value';

/** What one plan, validate or apply works with. */
export interface Run {
  loader: ConfigLoader;
  graphBuilder: DependencyGraphBuilder;
  writtenCheck: WrittenCheck;
  desiredStateBuilder: DesiredStateBuilder;
  runner: PlanRunner;
}

/** Each run gets its own scopes, instances and data source values, so runs at the same time never read each other's. */
export function newRun(stateManager: StateManager, providers: ProviderRegistry, files: ConfigFiles): Run {
  const scopes = new ScopeManager();
  const dataSources = new Map<string, Record<string, Value>>();
  const schemas = new Map<string, Schema>();
  const dataSchemas = new Map<string, Schema>();
  const instances = new Instances();
  const modules = new ModuleInstances();
  const planned = new Planned();
  const keys = new InstanceKeys(instances, modules);
  const resolver = new ReferenceResolver(scopes, dataSources, schemas, dataSchemas, instances, modules, planned, keys);
  const scanner = new ReferenceScanner(modules);
  const graphBuilder = new DependencyGraphBuilder(scanner, instances, modules);
  const resourcePlanner = new ResourcePlanner(providers);
  const reader = new DataSourceReader(providers, dataSchemas, dataSources);

  return {
    loader: new ConfigLoader(new ModuleLoader(files, scopes), scopes, dataSources, schemas, dataSchemas, resolver, providers, instances, modules, planned),
    graphBuilder,
    writtenCheck: new WrittenCheck(resolver, scopes, schemas, dataSchemas, providers),
    desiredStateBuilder: new DesiredStateBuilder(scopes, resolver, graphBuilder, instances, modules, planned, resourcePlanner, reader),
    runner: new PlanRunner(stateManager, new ActionExecutor(providers, resolver, resourcePlanner, new SameObjects(providers)), scopes, resolver, instances, modules, reader),
  };
}
