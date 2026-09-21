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

describe('Orchestrator - Phase 4: Data Flow', () => {
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
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'orchestrator-dataflow-test-'));

    // Setup mock provider
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

    // Ensure plan returns empty array by default
    (plan as Mock).mockReturnValue([]);
  });

  afterEach(async () => {
    if (tmpDir) await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('should use default variable value in root scope', async () => {
    // Variable defined in root with default
    const config = `
            variable "region" {
                default = "us-east-1"
}
            resource "test_resource" "res" {
  region = "\${var.region}"
}
`;

    // Mock Plan to return action
    (plan as Mock).mockReturnValue([
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'res',
        modulePath: [],
        attributes: { region: { type: 'Reference', value: ['var', 'region'] } },
      },
    ]);

    await apply(orchestrator, config);

    expect(writeMock).toHaveBeenCalled();
    const stateArg = writeMock.mock.calls[0][0];

    const resource = stateArg.resources['test_resource.res'];
    expect(resource).toBeDefined();
    // Variables are stored as { value: ..., context: ... } in state if they were passed,
    // but default variables are just values in the simplest case?
    // Let's check what Orchestrator.ts does for root variables.
    expect(resource.attributes.region).toBe('us-east-1');
  });

  it('should pass inputs to child module variables', async () => {
    const rootConfig = `
module "app" {
  source = "./app"
  env = "production"
}
`;

    const appConfig = `
            variable "env" {
                default = "dev"
}
            resource "test_resource" "server" {
  tags = "\${var.env}"
}
`;

    files['app/main.clay'] = appConfig;

    // Mock Plan
    (plan as Mock).mockReturnValue([
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'server',
        modulePath: ['app'],
        attributes: { tags: { type: 'Reference', value: ['var', 'env'] } },
      },
    ]);

    await apply(orchestrator, rootConfig);

    expect(writeMock).toHaveBeenCalled();
    const stateArg = writeMock.mock.calls[0][0];
    const resource = stateArg.resources['module.app.test_resource.server'];

    // Should be "production" (passed input), not "dev" (default)
    expect(resource.attributes.tags).toBe('production');
  });

  it('should handle nested variable scopes correctly', async () => {
    // Root (region=us) -> L2 (region=eu) -> Resource uses var.region
    const rootConfig = `
module "L2" {
  source = "./L2"
  region = "eu-west-1"
}
`;
    const l2Config = `
            variable "region" { default = "us-east-1" }
            resource "test_resource" "child" {
  loc = "\${var.region}"
}
`;

    files['L2/main.clay'] = l2Config;

    // Mock Plan
    (plan as Mock).mockReturnValue([
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'child',
        modulePath: ['L2'],
        attributes: { loc: { type: 'Reference', value: ['var', 'region'] } },
      },
    ]);

    await apply(orchestrator, rootConfig);

    const stateArg = writeMock.mock.calls[0][0];
    const resource = stateArg.resources['module.L2.test_resource.child'];

    expect(resource.attributes.loc).toBe('eu-west-1');
  });

  it('should pass variables to modules and use them in resources', async () => {
    const rootConfig = `
module "db" {
  source = "./db"
  db_name = "production-db"
}
            resource "test_resource" "app" {
  name = "my-app"
}
`;
    const dbConfig = `
variable "db_name" {
  default = "default-db"
}

resource "test_resource" "instance" {
  name = "\${var.db_name}"
}
`;

    files['db/main.clay'] = dbConfig;

    // Mock Plan
    (plan as Mock).mockReturnValue([
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'instance',
        modulePath: ['db'],
        attributes: { name: { type: 'Reference', value: ['var', 'db_name'] } },
      },
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'app',
        modulePath: [],
        attributes: { name: { type: 'String', value: 'my-app' } },
      },
    ]);

    mockProvider.create.mockImplementation(() => 'resource-id');

    await apply(orchestrator, rootConfig);

    const stateArg = writeMock.mock.calls[0][0];

    const dbResource = stateArg.resources['module.db.test_resource.instance'];
    expect(dbResource).toBeDefined();
    expect(dbResource.attributes.name).toBe('production-db');
  });
});
