import { Schema } from '@clay/contracts';
import { StateManager } from '@clay/state';

import { ActionExecutor } from './ActionExecutor';
import { ConfigLoader } from './ConfigLoader';
import { DataSourceReader } from '../plan/DataSourceReader';
import { DependencyGraphBuilder } from '../graph/DependencyGraphBuilder';
import { DesiredStateBuilder } from '../plan/DesiredStateBuilder';
import { ModuleLoader } from '../config/ModuleLoader';
import { PlanRunner } from './PlanRunner';
import { ResourcePlanner } from '../plan/ResourcePlanner';
import { WrittenCheck } from '../checks/WrittenCheck';
import { ConfigFiles } from '../config/ConfigFiles';
import { Instances } from '../instances/Instances';
import { ModuleInstances } from '../instances/ModuleInstances';
import { Planned } from '../values/Planned';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { ProvisionerRegistry } from '../providers/ProvisionerRegistry';
import { Provisioning } from '../providers/Provisioning';
import { InstanceKeys } from '../expressions/references/InstanceKeys';
import { ReferenceResolver } from '../expressions/ReferenceResolver';
import { ReferenceScanner } from '../expressions/references/ReferenceScanner';
import { SameObjects } from '../checks/sameObject';
import { ScopeManager } from '../config/ScopeManager';
import { Value } from '../values/Value';
import { Versions } from '../values/Versions';
import { Limit } from '../providers/Limit';

/** What one plan, validate or apply works with. */
export interface Run {
  loader: ConfigLoader;
  graphBuilder: DependencyGraphBuilder;
  writtenCheck: WrittenCheck;
  desiredStateBuilder: DesiredStateBuilder;
  runner: PlanRunner;
  modules: ModuleInstances;
}

/** What the engine has registered, which every run shares. */
export interface Registries {
  providers: ProviderRegistry;
  provisioners: ProvisionerRegistry;
}

/** Each run gets its own scopes, instances and data source values, so runs at the same time never read each other's. */
export function newRun(stateManager: StateManager, { providers, provisioners }: Registries, files: ConfigFiles, limit: Limit): Run {
  const versions = new Versions();
  const scopes = new ScopeManager(versions);
  const dataSources = new Map<string, Record<string, Value>>();
  const schemas = new Map<string, Schema>();
  const dataSchemas = new Map<string, Schema>();
  const provisionerSchemas = new Map<string, Schema>();
  const instances = new Instances();
  const modules = new ModuleInstances();
  const planned = new Planned(versions);
  const keys = new InstanceKeys(instances, modules);
  const resolver = new ReferenceResolver(scopes, dataSources, schemas, dataSchemas, instances, modules, planned, keys, versions);
  const scanner = new ReferenceScanner(modules);
  const graphBuilder = new DependencyGraphBuilder(scanner, instances, modules);
  const resourcePlanner = new ResourcePlanner(providers, limit);
  const provisioning = new Provisioning(provisioners, limit);
  const reader = new DataSourceReader(providers, dataSchemas, dataSources, versions, limit);

  return {
    loader: new ConfigLoader(
      new ModuleLoader(files, scopes),
      scopes,
      dataSources,
      schemas,
      dataSchemas,
      resolver,
      providers,
      provisioners,
      provisionerSchemas,
      instances,
      modules,
      planned,
      limit
    ),
    graphBuilder,
    writtenCheck: new WrittenCheck(resolver, scopes, schemas, dataSchemas, provisionerSchemas, providers, provisioners, limit),
    desiredStateBuilder: new DesiredStateBuilder(scopes, resolver, graphBuilder, instances, modules, planned, resourcePlanner, provisioning, reader, versions),
    runner: new PlanRunner(
      stateManager,
      new ActionExecutor(providers, provisioning, resolver, resourcePlanner, new SameObjects(providers, limit), versions, limit),
      scopes,
      resolver,
      instances,
      modules,
      reader
    ),
    modules,
  };
}
