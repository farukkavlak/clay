import { plan } from '@clay/planner';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { InMemoryFiles, Orchestrator } from '../src/index';
import { apply } from './apply';

const readMock = vi.fn().mockResolvedValue({ resources: {}, variables: {}, version: 1 });
const writeMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@clay/state', () => ({
  StateManager: vi.fn((backend) => ({
    read: readMock,
    write: writeMock,
    lock: vi.fn(),
    unlock: vi.fn(),
    backend,
  })),
  LocalBackend: vi.fn(() => ({
    read: readMock,
    write: writeMock,
    lock: vi.fn(),
    unlock: vi.fn(),
  })),
}));

vi.mock('@clay/planner', async () => ({
  ...(await vi.importActual<object>('@clay/planner')),
  plan: vi.fn(() => []),
}));

describe('Orchestrator - Phase 5: Scoped Data Sources', () => {
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
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'orchestrator-datasources-test-'));

    mockProvider = {
      resources: ['test_resource', 'aws_ami'],
      validate: vi.fn(),
      create: vi.fn().mockResolvedValue('created-id'),
      read: vi.fn().mockResolvedValue({ id: 'ami-12345', name: 'Ubuntu 20.04' }),
      update: vi.fn(),
      delete: vi.fn(),
      getSchema: vi.fn().mockReturnValue({}),
    };

    const { StateManager, LocalBackend } = await import('@clay/state');
    const backend = new LocalBackend(tmpDir);
    const stateManager = new StateManager(backend);
    files = {};
    orchestrator = new Orchestrator(stateManager, new InMemoryFiles(files));
    orchestrator.registerProvider(mockProvider);

    (plan as Mock).mockReturnValue([]);
  });

  afterEach(async () => {
    if (tmpDir) await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('should resolve data sources defined in modules', async () => {
    const rootConfig = `
module "app" {
  source = "./app"
}
`;
    const appConfig = `
            data "aws_ami" "ubuntu" {
  name = "focal"
}
            resource "test_resource" "server" {
  ami = "\${data.aws_ami.ubuntu.id}"
}
`;

    files['app/main.clay'] = appConfig;

    (plan as Mock).mockReturnValue([
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'server',
        modulePath: ['app'],
        attributes: { ami: { type: 'Reference', value: ['data', 'aws_ami', 'ubuntu', 'id'] } },
      },
    ]);

    await apply(orchestrator, rootConfig);

    const stateArg = writeMock.mock.calls[0][0];
    const resource = stateArg.resources['module.app.test_resource.server'];
    expect(resource.attributes.ami).toBe('ami-12345');
  });

  it('should NOT resolve root data source from child module without prefix (Scoping test)', async () => {
    const rootConfig = `
            data "aws_ami" "root_ami" {
  name = "global"
}
module "app" {
  source = "./app"
}
`;
    const appConfig = `
            resource "test_resource" "server" {
  ami = "\${data.aws_ami.root_ami.id}"
}
`;

    files['app/main.clay'] = appConfig;

    (plan as Mock).mockReturnValue([
      {
        type: 'CREATE',
        resourceType: 'test_resource',
        name: 'server',
        modulePath: ['app'],
        attributes: { ami: { type: 'Reference', value: ['data', 'aws_ami', 'root_ami', 'id'] } },
      },
    ]);

    // A module sees what it is passed and nothing else, data sources included.
    await expect(apply(orchestrator, rootConfig)).rejects.toThrow(/Data source "module.app.aws_ami.root_ami" not found/);
  });
});
