import { CreateRequest, ExactNumber, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, types, UpdateRequest } from '@clay/contracts';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryFiles, Orchestrator } from '../src/index';
import { apply } from './apply';

class MockDataProvider implements Provider {
  readonly resources = ['mock_resource'];
  readonly dataSources = ['mock_data'];
  data = new Map<string, Record<string, unknown>>();
  reads = 0;

  async getSchema(_type: string): Promise<Schema> {
    return { contact: { type: types.string }, owner: { type: types.string }, url: { type: types.string }, val: { type: types.string } };
  }

  async plan(type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(type), request);
  }

  async validate(_type: string, _inputs: Record<string, unknown>): Promise<void> {}

  async getDataSourceSchema(): Promise<Schema> {
    const read = { type: types.string, computed: true } as const;

    return { id: { type: types.string, required: true }, username: read, email: read, role: read, val: read, endpoint: read, port: { type: types.number, computed: true } };
  }

  async validateDataSource(_type: string, _inputs: Record<string, unknown>): Promise<void> {}

  async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return config;
  }

  async update(_type: string, { config }: UpdateRequest): Promise<Record<string, unknown>> {
    return config;
  }

  async delete(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async readDataSource(_type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.reads += 1;
    const id = inputs.id as string;
    if (this.data.has(id)) return this.data.get(id)!;

    throw new Error(`Data source mock_data with id ${id} not found`);
  }

  setMockData(id: string, data: Record<string, unknown>) {
    this.data.set(id, data);
  }
}

describe('Orchestrator - Data Sources', () => {
  let tmpDir: string;
  let orchestrator: Orchestrator;
  let mockProvider: MockDataProvider;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-data-test-'));
    const backend = new LocalBackend(tmpDir);
    const stateManager = new StateManager(backend);
    orchestrator = Orchestrator.create(stateManager, new InMemoryFiles({}));
    mockProvider = new MockDataProvider();
    orchestrator.registerProvider(mockProvider);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should resolve data source and use its attributes', async () => {
    mockProvider.setMockData('user-123', {
      username: 'testuser',
      email: 'test@example.com',
      role: 'admin',
    });

    const config = `
      data "mock_data" "user" {
        id = "user-123"
      }

      resource "mock_resource" "app" {
        owner = data.mock_data.user.username
        contact = data.mock_data.user.email
      }
    `;

    await apply(orchestrator, config);

    const backend = new LocalBackend(tmpDir);
    const stateManager = new StateManager(backend);
    const state = await stateManager.read();

    const resource = state.resources['mock_resource.app'];
    expect(resource).toBeDefined();
    expect(resource.attributes.owner).toBe('testuser');
    expect(resource.attributes.contact).toBe('test@example.com');
  });

  it('should refuse an attribute a data source only inherited', async () => {
    mockProvider.setMockData('user-123', { username: 'testuser' });

    const config = `
      data "mock_data" "user" {
        id = "user-123"
      }

      resource "mock_resource" "app" {
        owner = data.mock_data.user.toString
      }
    `;

    await expect(apply(orchestrator, config)).rejects.toThrow('Attribute "toString" not found on data source');
  });

  it('keeps what the configuration gave a data source when the read leaves it out', async () => {
    mockProvider.setMockData('user-123', { username: 'testuser' });
    const config = 'data "mock_data" "user" { id = "user-123" }\noutput "id" { value = data.mock_data.user.id }';

    const outputs = await apply(orchestrator, config);

    expect(outputs.id.value).toBe('user-123');
  });

  // Absent, undefined and null all read the same.
  it('keeps what the configuration gave a data source when the read gives it null', async () => {
    mockProvider.setMockData('user-123', { id: null, username: 'testuser' });
    const config = 'data "mock_data" "user" { id = "user-123" }\noutput "id" { value = data.mock_data.user.id }';

    const outputs = await apply(orchestrator, config);

    expect(outputs.id.value).toBe('user-123');
  });

  it('takes a read that returns what the configuration gave unchanged', async () => {
    mockProvider.setMockData('user-123', { id: 'user-123', username: 'testuser' });
    const config = 'data "mock_data" "user" { id = "user-123" }\noutput "id" { value = data.mock_data.user.id }';

    const outputs = await apply(orchestrator, config);

    expect(outputs.id.value).toBe('user-123');
  });

  it('refuses a read that changes what the configuration gave, placed in its block', async () => {
    mockProvider.setMockData('user-123', { id: 'other', username: 'testuser' });

    await expect(apply(orchestrator, 'data "mock_data" "user" { id = "user-123" }')).rejects.toMatchObject({
      message: 'mock_data read what its configuration did not give, which is a bug in the provider:\n  id = "other", where the configuration gave "user-123"',
      block: 'data "mock_data" "user"',
      position: { file: 'main.clay', line: 1, column: 1 },
    });
  });

  it('should throw error if data source provider is not registered', async () => {
    const config = `
      data "really_unknown_provider" "test" {
        id = "1"
      }
    `;
    await expect(apply(orchestrator, config)).rejects.toThrow('No provider reads data source "really_unknown_provider"');
  });

  it('refuses a misspelled name in any data source before reading one', async () => {
    mockProvider.setMockData('user-123', { username: 'testuser' });
    const config = `
      data "mock_data" "user" {
        id = "user-123"
      }
      data "mock_data" "other" {
        idd = "user-123"
      }
    `;

    await expect(apply(orchestrator, config)).rejects.toMatchObject({
      message: expect.stringContaining('mock_data has no attribute "idd"'),
      block: 'data "mock_data" "other"',
      position: { line: 6, column: 15 },
    });
    expect(mockProvider.reads).toBe(0);
  });

  it('should throw error if data source not found', async () => {
    const config = `
      data "mock_data" "missing" {
        id = "missing-id"
      }
    `;

    await expect(apply(orchestrator, config)).rejects.toMatchObject({
      message: 'Data source mock_data with id missing-id not found',
      block: 'data "mock_data" "missing"',
      position: { file: 'main.clay', line: 2, column: 7 },
    });
  });

  it('should throw error if data reference is incomplete', async () => {
    // The ID must be valid so the data source loads.
    mockProvider.setMockData('valid-id', { val: 'ok' });
    const config = `
      data "mock_data" "test" {
        id = "valid-id"
      }
      resource "mock_resource" "app" {
        val = data.mock_data.test
      }
    `;
    await expect(apply(orchestrator, config)).rejects.toThrow('Data source reference must include attribute');
  });

  it('should support string interpolation with data sources', async () => {
    mockProvider.setMockData('config', {
      endpoint: 'api.example.com',
      port: ExactNumber.parse('8080'),
    });

    const config = `
      data "mock_data" "api" {
        id = "config"
      }

      resource "mock_resource" "service" {
        url = "https://\${data.mock_data.api.endpoint}:\${data.mock_data.api.port}/v1"
      }
    `;

    await apply(orchestrator, config);

    const backend = new LocalBackend(tmpDir);
    const stateManager = new StateManager(backend);
    const state = await stateManager.read();
    const resource = state.resources['mock_resource.service'];

    expect(resource.attributes.url).toBe('https://api.example.com:8080/v1');
  });
});
