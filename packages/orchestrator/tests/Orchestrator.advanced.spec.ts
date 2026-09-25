import { ExactNumber, Provider, Schema } from '@clay/contracts';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryFiles, Orchestrator } from '../src/index';
import { apply } from './apply';

// Mock Provider for testing
class MockProvider implements Provider {
  readonly resources = ['mock_resource'];
  private createdResources: Map<string, Record<string, unknown>> = new Map();

  async getSchema(_type: string): Promise<Schema> {
    return {
      message: { type: 'string' },
      greeting: { type: 'string' },
      ref: { type: 'string' },
      depends_on: { type: 'string' },
      name: { type: 'string' },
    };
  }

  async validate(_type: string, _inputs: Record<string, unknown>): Promise<void> {
    // Always valid for testing
  }

  async create(_type: string, inputs: Record<string, unknown>): Promise<string> {
    const id = `mock_${Date.now()}_${Math.random()}`;
    this.createdResources.set(id, inputs);
    return id;
  }

  async update(id: string, _type: string, inputs: Record<string, unknown>): Promise<void> {
    if (!this.createdResources.has(id)) throw new Error(`Resource ${id} not found`);
    this.createdResources.set(id, inputs);
  }

  async delete(id: string): Promise<void> {
    this.createdResources.delete(id);
  }

  async read(_type: string, _inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {};
  }

  getCreatedResources(): Map<string, Record<string, unknown>> {
    return this.createdResources;
  }

  reset(): void {
    this.createdResources.clear();
  }
}

describe('Orchestrator: Advanced Features', () => {
  let tmpDir: string;
  let orchestrator: Orchestrator;
  let mockProvider: MockProvider;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-test-'));
    const backend = new LocalBackend(tmpDir);
    const stateManager = new StateManager(backend);
    orchestrator = Orchestrator.create(stateManager, new InMemoryFiles({}));
    mockProvider = new MockProvider();
    orchestrator.registerProvider(mockProvider);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('Variable Processing', () => {
    it('should process variables and use them with var.name reference', async () => {
      const config = `
        variable "greeting" {
          default = "Hello World"
        }

        resource "mock_resource" "test" {
          message = var.greeting
        }
      `;

      await apply(orchestrator, config);

      const created = mockProvider.getCreatedResources();
      expect(created.size).toBe(1);

      const [, inputs] = [...created.entries()][0];
      expect(inputs.message).toBe('Hello World');
    });

    it('should throw error for undefined variable', async () => {
      const config = `
        resource "mock_resource" "test" {
          message = var.undefined_var
        }
      `;

      await expect(apply(orchestrator, config)).rejects.toThrow('variable "undefined_var" is not defined');
    });
  });

  describe('String Interpolation', () => {
    it('should interpolate variables in strings', async () => {
      const config = `
        variable "name" {
          default = "Clay"
        }

        variable "version" {
          default = "1.0.0"
        }

        resource "mock_resource" "test" {
          greeting = "Hello \${var.name}! Version: \${var.version}"
        }
      `;

      await apply(orchestrator, config);

      const created = mockProvider.getCreatedResources();
      const [, inputs] = [...created.entries()][0];
      expect(inputs.greeting).toBe('Hello Clay! Version: 1.0.0');
    });

    it('should handle strings without interpolation', async () => {
      const config = `
        resource "mock_resource" "test" {
          message = "Plain text without interpolation"
        }
      `;

      await apply(orchestrator, config);

      const created = mockProvider.getCreatedResources();
      const [, inputs] = [...created.entries()][0];
      expect(inputs.message).toBe('Plain text without interpolation');
    });
  });

  describe('Resource Dependencies', () => {
    it('should respect dependency order from resource references', async () => {
      const config = `
        resource "mock_resource" "first" {
          name = "first"
        }

        resource "mock_resource" "second" {
          name = "second"
        }
      `;

      await apply(orchestrator, config);

      const created = mockProvider.getCreatedResources();
      expect(created.size).toBe(2);
    });

    it('should handle resource with reference to another resource attribute', async () => {
      const config1 = `
        resource "mock_resource" "first" {
          name = "first_resource"
        }
      `;

      await apply(orchestrator, config1);

      // Second apply with reference - this should add dependency edge
      const config2 = `
        resource "mock_resource" "first" {
          name = "first_resource"
        }

        resource "mock_resource" "second" {
          depends_on = mock_resource.first.name
        }
      `;

      await apply(orchestrator, config2);

      const created = mockProvider.getCreatedResources();
      expect(created.size).toBe(2);
    });
  });

  describe('Reference Resolution Errors', () => {
    it('should throw for a reference to a resource the config does not declare', async () => {
      const config = `
        resource "mock_resource" "test" {
          ref = nonexistent_resource.foo.bar
        }
      `;

      await expect(apply(orchestrator, config)).rejects.toThrow('is not declared in the configuration');
    });
  });

  describe('Output Processing', () => {
    it('should process and return outputs with literal values', async () => {
      const config = `
        output "my_string" {
          value = "test_value"
        }
        output "my_number" {
          value = 42
        }
      `;

      const outputs = await apply(orchestrator, config);

      expect(outputs).toEqual({
        my_string: 'test_value',
        my_number: ExactNumber.parse('42'),
      });
    });

    it('should process outputs with resource references', async () => {
      const config = `
        resource "mock_resource" "test" {
          name = "my_resource"
        }
        output "resource_name" {
          value = mock_resource.test.name
        }
      `;

      const outputs = await apply(orchestrator, config);

      expect(outputs.resource_name).toBe('my_resource');
    });

    it('should process outputs with string interpolation', async () => {
      const config = `
        variable "env" {
          default = "production"
        }
        output "message" {
          value = "Environment: \${var.env}"
        }
      `;

      const outputs = await apply(orchestrator, config);

      expect(outputs.message).toBe('Environment: production');
    });
  });

  describe('Circular Dependency Detection', () => {
    it('should detect direct circular dependency between resources', async () => {
      const config = `
        resource "mock_resource" "a" {
          ref = mock_resource.b.name
        }
        resource "mock_resource" "b" {
          ref = mock_resource.a.name
        }
      `;

      await expect(apply(orchestrator, config)).rejects.toThrow(/cycle detected/);
    });

    it('should detect indirect circular dependency (A -> B -> C -> A)', async () => {
      const config = `
        resource "mock_resource" "a" {
          ref = mock_resource.b.name
        }
        resource "mock_resource" "b" {
          ref = mock_resource.c.name
        }
        resource "mock_resource" "c" {
          ref = mock_resource.a.name
        }
      `;

      await expect(apply(orchestrator, config)).rejects.toThrow(/cycle detected/);
    });

    it('should detect self-reference circular dependency', async () => {
      const config = `
        resource "mock_resource" "self" {
          ref = mock_resource.self.name
        }
      `;

      await expect(apply(orchestrator, config)).rejects.toThrow(/cycle detected/);
    });
  });
});
