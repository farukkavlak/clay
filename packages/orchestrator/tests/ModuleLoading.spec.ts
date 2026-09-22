import { emptyState } from '@clay/contracts';
import { plan } from '@clay/planner';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { InMemoryFiles, Orchestrator } from '../src/index';
import { apply } from './apply';

/** Fresh per test: apply writes into whatever this returns, so one shared object would carry a test's resources into the next. */
const readMock = vi.fn();
const writeMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@clay/state', () => {
  const StateManager = vi.fn(function (backend) {
    return {
      read: readMock,
      write: writeMock,
      lock: vi.fn(),
      unlock: vi.fn(),
      backend,
    };
  });
  const LocalBackend = vi.fn(function () {
    return {
      read: readMock,
      write: writeMock,
      lock: vi.fn(),
      unlock: vi.fn(),
    };
  });
  return { StateManager, LocalBackend };
});

// Mock Planner
vi.mock('@clay/planner', async () => ({
  ...(await vi.importActual<object>('@clay/planner')),
  plan: vi.fn(() => []),
}));

describe('Orchestrator - Module Loading', () => {
  let tmpDir: string;
  let files: Record<string, string>;
  let orchestrator: Orchestrator;
  let mockProvider: {
    resources: string[];
    validate: Mock;
    create: Mock;
    read: Mock;
    update: Mock;
    delete: Mock;
    getSchema: Mock;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    readMock.mockResolvedValue(emptyState());
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'orchestrator-module-test-'));

    mockProvider = {
      resources: ['test_resource'],
      validate: vi.fn(),
      create: vi.fn().mockResolvedValue('created-id'),
      read: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getSchema: vi.fn().mockReturnValue({}),
    };

    const { StateManager, LocalBackend } = await import('@clay/state');
    const backend = new LocalBackend(tmpDir);
    const stateManager = new StateManager(backend);
    files = {};
    orchestrator = Orchestrator.create(stateManager, new InMemoryFiles(files));
    orchestrator.registerProvider(mockProvider);

    (plan as Mock).mockReturnValue([]);
  });

  afterEach(async () => {
    if (tmpDir) await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('should recursively load modules and flatten resources', async () => {
    const rootConfig = `
            module "vpc" {
                source = "./modules/vpc"
            }
        `;

    const vpcConfig = `
            resource "test_resource" "main" {
                name = "main-vpc"
            }
        `;

    files['modules/vpc/main.clay'] = vpcConfig;

    // Mock Plan to return expected actions
    (plan as Mock).mockReturnValue([
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'main',
        modulePath: ['vpc'],
        attributes: { name: 'main-vpc' }, // minimal attributes
      },
    ]);

    await apply(orchestrator, rootConfig);

    // Check StateManager write using the exposed mock
    expect(writeMock).toHaveBeenCalled();

    const stateArg = writeMock.mock.calls[0][0];
    const expectedKey = 'module.vpc.test_resource.main';

    expect(stateArg.resources).toHaveProperty(expectedKey);
    expect(stateArg.resources[expectedKey].id).toBe('created-id');
  });

  it('should handle nested modules', async () => {
    const rootConfig = `module "app" { source = "./app" }`;
    const appConfig = `module "db" { source = "./db" }`;
    const dbConfig = `resource "test_resource" "rds" {}`;

    files['app/main.clay'] = appConfig;
    files['app/db/main.clay'] = dbConfig;

    // Reset mock calls from previous tests or setup
    writeMock.mockClear();

    // Mock Plan to return expected actions for nested module
    (plan as Mock).mockReturnValue([
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'rds',
        modulePath: ['app', 'db'],
        attributes: {},
      },
    ]);

    await apply(orchestrator, rootConfig);

    expect(writeMock).toHaveBeenCalled();
    const stateArg = writeMock.mock.calls[0][0];

    const expectedKey = 'module.app.module.db.test_resource.rds';
    expect(stateArg.resources).toHaveProperty(expectedKey);
    expect(stateArg.resources).toHaveProperty(expectedKey);
  });

  it('should handle deep nesting (5 levels)', async () => {
    // level1 -> level2 -> level3 -> level4 -> level5 (resource)
    const config1 = `module "L2" { source = "./L2" }`;
    const config2 = `module "L3" { source = "./L3" }`;
    const config3 = `module "L4" { source = "./L4" }`;
    const config4 = `module "L5" { source = "./L5" }`;
    const config5 = `resource "test_resource" "deep" {}`;

    files['L2/main.clay'] = config2;
    files['L2/L3/main.clay'] = config3;
    files['L2/L3/L4/main.clay'] = config4;
    files['L2/L3/L4/L5/main.clay'] = config5;

    // Reset mock calls
    writeMock.mockClear();
    // Mock Plan to return expected actions
    (plan as Mock).mockReturnValue([
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'deep',
        modulePath: ['L2', 'L3', 'L4', 'L5'],
        attributes: {},
      },
    ]);

    await apply(orchestrator, config1);

    expect(writeMock).toHaveBeenCalled();
    const stateArg = writeMock.mock.calls[0][0];

    const expectedKey = 'module.L2.module.L3.module.L4.module.L5.test_resource.deep';

    expect(stateArg.resources).toHaveProperty(expectedKey);
  });

  it('should throw error if module source is missing', async () => {
    const rootConfig = `module "invalid" {}`;

    // Mock plan to return relevant action if needed, but plan() might fail before if syntax is valid but semantic check fails
    // Here we are testing orchestrator.run -> moduleLoader.loadModuleTree
    // We need to bypass plan() mock and let module loader run.

    // In Orchestrator.run:
    // 1. Parser parses root config
    // 2. ModuleLoader loads tree
    // So we just need apply() to be called.

    await expect(apply(orchestrator, rootConfig)).rejects.toThrow('missing a valid "source" attribute');
  });

  it('should throw error if module source file not found', async () => {
    const rootConfig = `module "missing" { source = "./missing" }`;

    await expect(apply(orchestrator, rootConfig)).rejects.toThrow('Module source not found at: missing/main.clay');
  });

  it('refuses a root module whose source is the configuration it was called from', async () => {
    await expect(apply(orchestrator, `module "self" { source = "." }`)).rejects.toThrow(/Module source cycle detected: \. -> \.$/);
  });

  it('refuses a module whose source is the directory it was loaded from', async () => {
    files['a/main.clay'] = `module "self" { source = "." }`;

    await expect(apply(orchestrator, `module "a" { source = "./a" }`)).rejects.toThrow(/Module source cycle detected: \. -> a -> a$/);
  });

  it('refuses a source that spells the directory it was loaded from with a trailing slash', async () => {
    files['a/main.clay'] = `module "self" { source = "./" }`;

    await expect(apply(orchestrator, `module "a" { source = "./a" }`)).rejects.toThrow(/Module source cycle detected: \. -> a -> a$/);
  });

  it('refuses an input the module declares no variable for', async () => {
    files['m/main.clay'] = `variable "content" { default = "fallback" }`;

    await expect(apply(orchestrator, `module "m" { source = "./m" contnet = "typo" }`)).rejects.toThrow('module "m" has no variable "contnet"');
  });

  it('refuses an input to a module that declares no variable at all', async () => {
    files['m/main.clay'] = `resource "test_resource" "one" {}`;

    await expect(apply(orchestrator, `module "m" { source = "./m" content = "x" }`)).rejects.toThrow('module "m" has no variable "content"');
  });

  it('refuses two modules whose sources reach each other', async () => {
    files['a/main.clay'] = `module "b" { source = "../b" }`;
    files['b/main.clay'] = `module "a" { source = "../a" }`;

    await expect(apply(orchestrator, `module "a" { source = "./a" }`)).rejects.toThrow(/Module source cycle detected: \. -> a -> b -> a$/);
  });
});
