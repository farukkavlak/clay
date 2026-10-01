import { planFromSchema, PlannedChange, PlanRequest, Provider, Schema } from '@clay/contracts';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryFiles, Orchestrator } from '../src/index';
import { apply } from './apply';

// Mock Provider for testing Data Sources
class MockDataProvider implements Provider {
  readonly resources = ['mock_resource'];
  readonly dataSources = ['mock_data'];
  data = new Map<string, Record<string, unknown>>();

  async getSchema(_type: string): Promise<Schema> {
    return {};
  }

  async plan(type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(type), request);
  }

  async validate(_type: string, _inputs: Record<string, unknown>): Promise<void> {}

  async validateDataSource(_type: string, _inputs: Record<string, unknown>): Promise<void> {}

  async create(_type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return inputs;
  }

  async update(_type: string, _prior: Record<string, unknown>, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return inputs;
  }

  async delete(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async readDataSource(_type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = inputs.id as string;
    if (this.data.has(id)) return this.data.get(id)!;

    throw new Error(`Data source mock_data with id ${id} not found`);
  }

  // Helper to setup mock data
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
    // Setup mock data
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

    // Apply
    await apply(orchestrator, config);

    // Verify
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

  it('should throw error if data source provider is not registered', async () => {
    const config = `
      data "really_unknown_provider" "test" {
        id = "1"
      }
    `;
    await expect(apply(orchestrator, config)).rejects.toThrow('No provider reads data source "really_unknown_provider"');
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
    // Reference without attribute: data.type.name
    // Must use valid ID so data source loading succeeds
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
      port: 8080,
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
