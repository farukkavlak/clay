import { plan } from '@clay/planner';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { Orchestrator } from '../src/index';
import { apply } from './apply';

vi.mock('node:fs');

const readMock = vi.fn().mockResolvedValue({ resources: {}, variables: {}, version: 1 });
const writeMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@clay/state', () => {
  const StateManager = vi.fn((backend) => ({
    read: readMock,
    write: writeMock,
    lock: vi.fn(),
    unlock: vi.fn(),
    backend,
  }));
  const LocalBackend = vi.fn(() => ({
    read: readMock,
    write: writeMock,
    lock: vi.fn(),
    unlock: vi.fn(),
  }));
  return { StateManager, LocalBackend };
});

// Mock Planner
vi.mock('@clay/planner', async () => ({
  ...(await vi.importActual<object>('@clay/planner')),
  plan: vi.fn(() => []),
}));

describe('Orchestrator - Module Loading', () => {
  let tmpDir: string;
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
    orchestrator = new Orchestrator(stateManager);
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

    // Mock FS Sync for Module Loading
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.includes('modules/vpc/main.clay')) return vpcConfig;
      return '';
    });

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

    await apply(orchestrator, rootConfig, '/root');

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

    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.endsWith('app/main.clay')) return appConfig;
      if (filePath.endsWith('db/main.clay')) return dbConfig;
      // The orchestrator re-reads the root config for execution, so we need to return it
      return rootConfig;
    });

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

    await apply(orchestrator, rootConfig, '/root');

    expect(writeMock).toHaveBeenCalled();
    const stateArg = writeMock.mock.calls[0][0];

    console.log('DEBUG ACTUAL KEYS:', Object.keys(stateArg.resources));
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

    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
      if (filePath.endsWith('L2/main.clay')) return config2;
      if (filePath.endsWith('L3/main.clay')) return config3;
      if (filePath.endsWith('L4/main.clay')) return config4;
      if (filePath.endsWith('L5/main.clay')) return config5;
      return config1; // Root (L1)
    });

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

    await apply(orchestrator, config1, '/root'); // Pass root config content

    expect(writeMock).toHaveBeenCalled();
    const stateArg = writeMock.mock.calls[0][0];

    const expectedKey = 'module.L2.module.L3.module.L4.module.L5.test_resource.deep';

    expect(stateArg.resources).toHaveProperty(expectedKey);
  });

  it('should throw error if module source is missing', async () => {
    const rootConfig = `module "invalid" {}`;
    (fs.existsSync as Mock).mockReturnValue(true);

    // Mock plan to return relevant action if needed, but plan() might fail before if syntax is valid but semantic check fails
    // Here we are testing orchestrator.run -> moduleLoader.loadModuleTree
    // We need to bypass plan() mock and let module loader run.

    // In Orchestrator.run:
    // 1. Parser parses root config
    // 2. ModuleLoader loads tree
    // So we just need apply() to be called.

    await expect(apply(orchestrator, rootConfig, '/root')).rejects.toThrow('missing a valid "source" attribute');
  });

  it('should throw error if module source file not found', async () => {
    const rootConfig = `module "missing" { source = "./missing" }`;
    (fs.existsSync as Mock).mockImplementation((path) => !path.toString().includes('missing/main.clay'));

    await expect(apply(orchestrator, rootConfig, '/root')).rejects.toThrow('Module source not found');
  });
});
