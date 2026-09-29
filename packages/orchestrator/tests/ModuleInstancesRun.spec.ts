import { Address, ModuleAddress, Provider } from '@clay/contracts';
import { isUnknown } from '@clay/planner';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ActionExecutor } from '../src/components/ActionExecutor';
import { ConfigLoader } from '../src/components/ConfigLoader';
import { DependencyGraphBuilder } from '../src/components/DependencyGraphBuilder';
import { DesiredStateBuilder } from '../src/components/DesiredStateBuilder';
import { ModuleLoader } from '../src/components/ModuleLoader';
import { PlanRunner } from '../src/components/PlanRunner';
import { InMemoryFiles, Orchestrator } from '../src/index';
import { Instances } from '../src/Instances';
import { ModuleInstances } from '../src/ModuleInstances';
import { ProviderRegistry } from '../src/ProviderRegistry';
import { ReferenceResolver } from '../src/resolvers/ReferenceResolver';
import { ReferenceScanner } from '../src/resolvers/ReferenceScanner';
import { ScopeManager } from '../src/scope/ScopeManager';
import { apply } from './apply';

/** Makes two instances, [0] and [1], of each module the root calls, as a count of 2 would; a module in one has one instance in each. */
class TwoOfEachAtRoot extends ModuleInstances {
  private made = new Map<string, ModuleAddress[]>();

  override expand(caller: ModuleAddress, name: string): void {
    const keys = caller.isRoot() ? [0, 1] : [undefined];
    this.made.set(
      caller.child(name).toString(),
      this.of(caller).flatMap((instance) => keys.map((key) => instance.child(name, key)))
    );
  }

  override of(module: ModuleAddress): ModuleAddress[] {
    return module.isRoot() ? [module] : this.made.get(module.toString())!;
  }
}

/** Keeps what it is given, so state holds the inputs. */
const recorder: Provider = {
  resources: ['rec'],
  getSchema: async () => ({}),
  validate: async () => {},
  read: async () => ({}),
  create: async (_, inputs) => String(inputs.value),
  update: async () => {},
  delete: async () => {},
};

/** Wired as `Orchestrator.create` wires it, with the module instances given. */
function orchestrator(dir: string, files: Record<string, string>, modules: ModuleInstances): Orchestrator {
  const stateManager = new StateManager(new LocalBackend(dir));
  const providers = new ProviderRegistry();
  const scopes = new ScopeManager();
  const dataSources = new Map<string, Record<string, unknown>>();
  const instances = new Instances();
  const resolver = new ReferenceResolver(scopes, dataSources, instances);
  const scanner = new ReferenceScanner(instances);
  const graphBuilder = new DependencyGraphBuilder(scanner, instances);

  const engine = new Orchestrator(
    stateManager,
    providers,
    new ConfigLoader(new ModuleLoader(new InMemoryFiles(files), scopes), scopes, dataSources, resolver, providers, instances),
    graphBuilder,
    new DesiredStateBuilder(scopes, scanner, resolver, graphBuilder, instances, modules),
    new PlanRunner(stateManager, new ActionExecutor(providers, resolver), scopes, resolver, instances, modules)
  );
  engine.registerProvider(recorder);
  return engine;
}

const modules = (extra = '') => ({
  'm/main.clay': `
    variable "text" {}
    resource "rec" "a" {
      count = 2
      value = "\${var.text}-\${count.index}"
    }
    resource "rec" "e" {
      for_each = { k = "v" }
      value = "\${each.value}"
    }
    module "o" { source = "./o" }
    module "n" {
      source = "./n"
      text = "\${module.o.out}"
    }
    resource "rec" "c" { value = "\${module.n.out}-\${rec.a[1].value}" }
    ${extra}
  `,
  'm/o/main.clay': `
    resource "rec" "r" { value = "o" }
    output "out" { value = "\${rec.r.value}" }
  `,
  'm/n/main.clay': `
    variable "text" {}
    resource "rec" "s" { value = "\${var.text}" }
    output "out" { value = "\${var.text}-n" }
  `,
});

const root = (top: string) => `
  resource "rec" "top" { value = "${top}" }
  module "m" {
    source = "./m"
    text = "\${rec.top.value}"
  }
`;

// No configuration makes two instances of a module yet, so the instances are made here, and each node is walked once for each.
describe('a module with two instances', () => {
  let dir: string;

  const stored = () => new LocalBackend(dir).read();

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-module-instances-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('plans and applies every instance of the blocks in it, each reading its own instance', async () => {
    await apply(orchestrator(dir, modules(), new TwoOfEachAtRoot()), root('top'));

    const { resources } = await stored();
    const values = Object.fromEntries(Object.entries(resources).map(([address, resource]) => [address, resource.attributes.value]));
    expect(values).toEqual({
      'rec.top': 'top',
      'module.m[0].rec.a[0]': 'top-0',
      'module.m[0].rec.a[1]': 'top-1',
      'module.m[0].rec.e["k"]': 'v',
      'module.m[0].rec.c': 'o-n-top-1',
      'module.m[0].module.o.rec.r': 'o',
      'module.m[0].module.n.rec.s': 'o',
      'module.m[1].rec.a[0]': 'top-0',
      'module.m[1].rec.a[1]': 'top-1',
      'module.m[1].rec.e["k"]': 'v',
      'module.m[1].rec.c': 'o-n-top-1',
      'module.m[1].module.o.rec.r': 'o',
      'module.m[1].module.n.rec.s': 'o',
    });
  });

  // Each instance's outputs and inputs are read in that instance, so what an apply made plans as it is.
  it('plans no change once applied', async () => {
    await apply(orchestrator(dir, modules(), new TwoOfEachAtRoot()), root('top'));

    const { actions } = await orchestrator(dir, modules(), new TwoOfEachAtRoot()).plan(root('top'));

    expect(actions.filter((action) => action.type !== 'NO_OP').map((action) => Address.of(action).toString())).toEqual([]);
  });

  it('keeps what an instance read from its own instance of the module only, so a delete waits on nothing in another', async () => {
    await apply(orchestrator(dir, modules(), new TwoOfEachAtRoot()), root('top'));

    const { resources } = await stored();
    expect(resources['module.m[1].rec.c'].dependencies).toEqual(['module.m[1].module.o.rec.r', 'module.m[1].rec.a[0]', 'module.m[1].rec.a[1]']);
    expect(resources['module.m[0].rec.a[0]'].dependencies).toEqual(['rec.top']);
    // Two modules side by side sit in the same instance of the module that calls both.
    expect(resources['module.m[1].module.n.rec.s'].dependencies).toEqual(['module.m[1].module.o.rec.r']);
  });

  // The input reads a resource the plan will change, so every instance reading the input plans against a value not known yet, not the one in state.
  it('plans an input fed by a changing resource as unknown in every instance', async () => {
    await apply(orchestrator(dir, modules(), new TwoOfEachAtRoot()), root('top'));

    const { actions } = await orchestrator(dir, modules(), new TwoOfEachAtRoot()).plan(root('changed'));

    const byAddress = new Map(actions.map((action) => [Address.of(action).toString(), action]));
    for (const address of ['module.m[0].rec.a[0]', 'module.m[1].rec.a[0]']) {
      expect(byAddress.get(address)?.type, address).toBe('UPDATE');
      expect(isUnknown(byAddress.get(address)?.changes?.value.new), address).toBe(true);
    }
  });

  it('refuses an index past the count of a block in an instance of the module', async () => {
    const reading = modules('resource "rec" "d" { value = "${rec.a[5].value}" }');

    await expect(orchestrator(dir, reading, new TwoOfEachAtRoot()).plan(root('top'))).rejects.toThrow('rec.a has 2 instances, [0] to [1]');
  });

  it('refuses a key for_each does not give to a block in an instance of the module', async () => {
    const reading = modules('resource "rec" "d" { value = "${rec.e["x"].value}" }');

    await expect(orchestrator(dir, reading, new TwoOfEachAtRoot()).plan(root('top'))).rejects.toThrow('rec.e has no instance ["x"], only ["k"]');
  });
});
