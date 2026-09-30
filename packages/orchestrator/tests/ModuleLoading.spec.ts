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
    dataSources: string[];
    validate: Mock;
    create: Mock;
    read: Mock;
    validateDataSource: Mock;
    readDataSource: Mock;
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
      dataSources: [],
      validate: vi.fn(),
      create: vi.fn().mockResolvedValue('created-id'),
      read: vi.fn(async (_type, _id, prior) => prior),
      validateDataSource: vi.fn(),
      readDataSource: vi.fn(),
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
        modulePath: [{ name: 'vpc' }],
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
        modulePath: [{ name: 'app' }, { name: 'db' }],
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
        modulePath: [{ name: 'L2' }, { name: 'L3' }, { name: 'L4' }, { name: 'L5' }],
        attributes: {},
      },
    ]);

    await apply(orchestrator, config1);

    expect(writeMock).toHaveBeenCalled();
    const stateArg = writeMock.mock.calls[0][0];

    const expectedKey = 'module.L2.module.L3.module.L4.module.L5.test_resource.deep';

    expect(stateArg.resources).toHaveProperty(expectedKey);
  });

  it('refuses a module with no source, pointing at the block', async () => {
    await expect(apply(orchestrator, `module "invalid" {}`)).rejects.toMatchObject({
      message: expect.stringContaining('missing a valid "source" attribute') as string,
      position: { file: 'main.clay', line: 1, column: 1 },
      block: 'module "invalid"',
    });
  });

  it('refuses a module source with no configuration in it, pointing at the source', async () => {
    await expect(apply(orchestrator, `module "missing" { source = "./missing" }`)).rejects.toMatchObject({
      message: 'Module source not found at: missing/main.clay',
      position: { file: 'main.clay', line: 1, column: 29 },
      block: 'module "missing"',
    });
  });

  it.each([
    ['a bare name', 'app'],
    ['a registry address', 'hashicorp/consul/aws'],
    ['a remote address', 'git::https://example.com/app.git'],
    ['an absolute path', '/srv/modules/app'],
    ['a directory without its slash', '.'],
    ['a parent without its slash', '..'],
    ['an absolute path with ./ inside it', '/srv/./app'],
  ])('refuses %s as a source, pointing at it', async (_, source) => {
    files['app/main.clay'] = '';

    await expect(apply(orchestrator, `module "app" { source = "${source}" }`)).rejects.toMatchObject({
      message: `module "app" has source "${source}", which is not a local path: a source starts with ./ or ../`,
      position: { file: 'main.clay', line: 1, column: 25 },
      block: 'module "app"',
    });
  });

  // A path is joined with forward slashes, so a backslash would be part of a directory's name.
  it('refuses a source spelled with a backslash', async () => {
    await expect(apply(orchestrator, String.raw`module "app" { source = ".\\app" }`)).rejects.toMatchObject({
      message: String.raw`module "app" has source ".\app", which is not a local path: a source starts with ./ or ../`,
    });
  });

  it('refuses a root module whose source is the configuration it was called from', async () => {
    await expect(apply(orchestrator, `module "self" { source = "./" }`)).rejects.toThrow(/Module source cycle detected: \. -> \.$/);
  });

  it('refuses a module whose source is the directory it was loaded from, pointing at the source in that module', async () => {
    files['a/main.clay'] = `module "self" { source = "../a" }`;

    await expect(apply(orchestrator, `module "a" { source = "./a" }`)).rejects.toMatchObject({
      message: expect.stringMatching(/Module source cycle detected: \. -> a -> a$/) as string,
      position: { file: 'a/main.clay', line: 1, column: 26 },
      block: 'module "self"',
      module: 'module.a',
    });
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
