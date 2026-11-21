import { StateManager } from '@clay/state';

import { ActionExecutor } from './ActionExecutor';
import { ConfigLoader } from './ConfigLoader';
import { DataSourceReader } from '../plan/DataSourceReader';
import { DependencyGraphBuilder } from '../graph/DependencyGraphBuilder';
import { DataPlanner } from '../plan/DataPlanner';
import { DesiredStateBuilder } from '../plan/DesiredStateBuilder';
import { PlanReader } from '../plan/PlanReader';
import { ModuleLoader } from '../config/ModuleLoader';
import { ApplyVisitor } from './ApplyVisitor';
import { PlanRunner } from './PlanRunner';
import { ProvisionerRunner } from './ProvisionerRunner';
import { ResourcePlanner } from '../plan/ResourcePlanner';
import { WrittenCheck } from '../checks/WrittenCheck';
import { ConfigFiles } from '../config/ConfigFiles';
import { Instances } from '../instances/Instances';
import { ModuleInstances } from '../instances/ModuleInstances';
import { Planned } from '../values/Planned';
import { ProviderInstances } from '../providers/ProviderInstances';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { Schemas } from '../providers/Schemas';
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
  /** The run's own instances, which its walk configures. */
  providers: ProviderInstances;
}

/** What the engine has registered, which every run shares. */
export interface Registries {
  providers: ProviderRegistry;
  provisioners: ProvisionerRegistry;
}

/** Each run gets its own scopes, instances and data source values, so runs at the same time never read each other's. */
export function newRun(stateManager: StateManager, { providers, provisioners }: Registries, files: ConfigFiles, limit: Limit, workspace: string | undefined): Run {
  const versions = new Versions();
  const scopes = new ScopeManager(versions);
  const dataSources = new Map<string, Record<string, Value>>();
  const schemas = new Schemas();
  const instances = new Instances();
  const modules = new ModuleInstances();
  const configured = new ProviderInstances(providers, schemas.configs, limit);
  const planned = new Planned(versions);
  const keys = new InstanceKeys(instances, modules);
  const resolver = new ReferenceResolver(scopes, dataSources, schemas, instances, modules, planned, keys, versions, workspace);
  const scanner = new ReferenceScanner(modules);
  const graphBuilder = new DependencyGraphBuilder(scanner, instances, modules, providers);
  const resourcePlanner = new ResourcePlanner(configured, limit);
  const provisioning = new Provisioning(provisioners, limit);
  const reader = new DataSourceReader(configured, schemas.dataSources, dataSources, versions, limit);
  const planReader = new PlanReader(resolver, instances);

  return {
    loader: new ConfigLoader(new ModuleLoader(files, scopes), scopes, dataSources, schemas, resolver, providers, provisioners, instances, modules, planned, limit),
    graphBuilder,
    writtenCheck: new WrittenCheck(resolver, scopes, schemas, providers, provisioners, limit),
    desiredStateBuilder: new DesiredStateBuilder(
      scopes,
      resolver,
      graphBuilder,
      instances,
      modules,
      planned,
      resourcePlanner,
      provisioning,
      new DataPlanner(graphBuilder, instances, modules, planned, reader, planReader),
      planReader,
      versions,
      configured,
      schemas.resources
    ),
    runner: new PlanRunner(
      stateManager,
      new ActionExecutor(configured, new ProvisionerRunner(provisioning, resolver), resolver, resourcePlanner, new SameObjects(configured, limit), versions, limit),
      new ApplyVisitor(scopes, resolver, instances, modules, reader, configured),
      instances
    ),
    modules,
    providers: configured,
  };
}
