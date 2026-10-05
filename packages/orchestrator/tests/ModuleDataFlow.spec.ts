import { CreateRequest, emptyState, planFromSchema, PlanRequest, Schema, types, UNKNOWN, UpdateRequest } from '@clay/contracts';
import { plan } from '@clay/planner';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { InMemoryFiles, Orchestrator } from '../src/index';
import { apply } from './apply';

/** Fresh per test: apply writes into what this returns, so a shared object would leak resources between tests. */
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

vi.mock('@clay/planner', async () => ({
  ...(await vi.importActual<object>('@clay/planner')),
  plan: vi.fn(() => []),
}));

const schema: Schema = { loc: { type: types.string }, name: { type: types.string }, region: { type: types.string }, tags: { type: types.string } };

describe('Orchestrator - Phase 4: Data Flow', () => {
  let tmpDir: string;
  let files: Record<string, string>;
  let orchestrator: Orchestrator;
  let mockProvider: {
    resources: string[];
    dataSources: string[];
    validate: Mock;
    create: Mock;
    read: Mock;
    getDataSourceSchema: Mock;
    validateDataSource: Mock;
    readDataSource: Mock;
    update: Mock;
    delete: Mock;
    getSchema: Mock;
    plan: Mock;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    readMock.mockResolvedValue(emptyState());
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'orchestrator-dataflow-test-'));

    mockProvider = {
      resources: ['test_resource'],
      dataSources: [],
      validate: vi.fn(),
      create: vi.fn(async (_type: string, { config }: CreateRequest) => config),
      read: vi.fn(async (_type, prior) => prior),
      getDataSourceSchema: vi.fn().mockResolvedValue({}),
      validateDataSource: vi.fn(),
      readDataSource: vi.fn(),
      update: vi.fn(async (_type: string, { config }: UpdateRequest) => config),
      delete: vi.fn(),
      getSchema: vi.fn().mockReturnValue(schema),
      plan: vi.fn(async (_type: string, request: PlanRequest) => planFromSchema(schema, request)),
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

  it('should use default variable value in root scope', async () => {
    const config = `
            variable "region" {
                default = "us-east-1"
}
            resource "test_resource" "res" {
  region = "\${var.region}"
}
`;

    (plan as Mock).mockReturnValue([
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'res',
        modulePath: [],
        attributes: { region: { type: 'Reference', value: ['var', 'region'] } },
        planned: { region: UNKNOWN },
        after: { region: UNKNOWN },
      },
    ]);

    await apply(orchestrator, config);

    expect(writeMock).toHaveBeenCalled();
    const stateArg = writeMock.mock.calls[0][0];

    const resource = stateArg.resources['test_resource.res'];
    expect(resource).toBeDefined();
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

    (plan as Mock).mockReturnValue([
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'server',
        modulePath: [{ name: 'app' }],
        attributes: { tags: { type: 'Reference', value: ['var', 'env'] } },
        planned: { tags: UNKNOWN },
        after: { tags: UNKNOWN },
      },
    ]);

    await apply(orchestrator, rootConfig);

    expect(writeMock).toHaveBeenCalled();
    const stateArg = writeMock.mock.calls[0][0];
    const resource = stateArg.resources['module.app.test_resource.server'];

    // The input wins over the default.
    expect(resource.attributes.tags).toBe('production');
  });

  it('should handle nested variable scopes correctly', async () => {
    // root (region=us) -> L2 (region=eu) -> resource reads var.region
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

    (plan as Mock).mockReturnValue([
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'child',
        modulePath: [{ name: 'L2' }],
        attributes: { loc: { type: 'Reference', value: ['var', 'region'] } },
        planned: { loc: UNKNOWN },
        after: { loc: UNKNOWN },
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

    (plan as Mock).mockReturnValue([
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'instance',
        modulePath: [{ name: 'db' }],
        attributes: { name: { type: 'Reference', value: ['var', 'db_name'] } },
        planned: { name: UNKNOWN },
        after: { name: UNKNOWN },
      },
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'app',
        modulePath: [],
        attributes: { name: { type: 'String', value: 'my-app' } },
        planned: { name: 'my-app' },
        after: { name: 'my-app' },
      },
    ]);

    mockProvider.create.mockImplementation(async (_type: string, { config }: CreateRequest) => config);

    await apply(orchestrator, rootConfig);

    const stateArg = writeMock.mock.calls[0][0];

    const dbResource = stateArg.resources['module.db.test_resource.instance'];
    expect(dbResource).toBeDefined();
    expect(dbResource.attributes.name).toBe('production-db');
  });
});
