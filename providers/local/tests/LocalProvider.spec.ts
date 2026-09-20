import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalProvider } from '../src/index';

describe('LocalProvider', () => {
  let provider: LocalProvider;
  let tmpDir: string;

  beforeEach(async () => {
    provider = new LocalProvider();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-provider-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('Validation', () => {
    it('should validate local_file with path and content', async () => {
      await expect(
        provider.validate('local_file', {
          path: '/tmp/test.txt',
          content: 'Hello',
        })
      ).resolves.not.toThrow();
    });

    it('should throw if path is missing', async () => {
      await expect(
        provider.validate('local_file', {
          content: 'Hello',
        })
      ).rejects.toThrow('requires "path"');
    });

    it('should throw if content is missing', async () => {
      await expect(
        provider.validate('local_file', {
          path: '/tmp/test.txt',
        })
      ).rejects.toThrow('requires "content"');
    });

    it('should accept empty content and write an empty file', async () => {
      const filePath = path.join(tmpDir, 'empty.txt');
      await expect(provider.validate('local_file', { path: filePath, content: '' })).resolves.not.toThrow();

      await provider.create('local_file', { path: filePath, content: '' });

      expect(await fs.readFile(filePath, 'utf8')).toBe('');
    });

    it('should throw if path is not a string', async () => {
      await expect(
        provider.validate('local_file', {
          path: 123,
          content: 'Hello',
        })
      ).rejects.toThrow('requires "path"');
    });
  });

  describe('CREATE', () => {
    it('should create a file with content', async () => {
      const filePath = path.join(tmpDir, 'test.txt');
      const content = 'Hello World';

      const id = await provider.create('local_file', {
        path: filePath,
        content,
      });

      expect(id).toBe(path.resolve(filePath));

      const fileContent = await fs.readFile(filePath, 'utf8');
      expect(fileContent).toBe(content);
    });

    it('should create parent directories if they do not exist', async () => {
      const filePath = path.join(tmpDir, 'nested', 'dir', 'test.txt');
      const content = 'Nested file';

      await provider.create('local_file', {
        path: filePath,
        content,
      });

      const fileContent = await fs.readFile(filePath, 'utf8');
      expect(fileContent).toBe(content);
    });

    it('should throw for unsupported resource type', async () => {
      await expect(
        provider.create('unknown_type', {
          path: '/tmp/test.txt',
          content: 'Hello',
        })
      ).rejects.toThrow('Unsupported resource type');
    });
  });

  describe('UPDATE', () => {
    it('should update file content', async () => {
      const filePath = path.join(tmpDir, 'test.txt');

      // Create file first
      await fs.writeFile(filePath, 'Original content', 'utf8');

      // Update
      await provider.update(filePath, 'local_file', {
        path: filePath,
        content: 'Updated content',
      });

      const fileContent = await fs.readFile(filePath, 'utf8');
      expect(fileContent).toBe('Updated content');
    });

    it('should throw for unsupported resource type', async () => {
      await expect(
        provider.update('/tmp/test.txt', 'unknown_type', {
          content: 'Hello',
        })
      ).rejects.toThrow('Unsupported resource type');
    });
  });

  describe('DELETE', () => {
    it('should delete a file', async () => {
      const filePath = path.join(tmpDir, 'test.txt');

      // Create file first
      await fs.writeFile(filePath, 'Content', 'utf8');

      // Verify it exists
      await expect(fs.access(filePath)).resolves.not.toThrow();

      // Delete
      await provider.delete(filePath, 'local_file');

      // Verify it's gone
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('treats a file that is already gone as deleted', async () => {
      await expect(provider.delete(path.join(tmpDir, 'gone.txt'), 'local_file')).resolves.toBeUndefined();
    });

    it('still fails when the file cannot be removed for another reason', async () => {
      // A directory is not a file, so unlink refuses it with something other than ENOENT.
      await expect(provider.delete(tmpDir, 'local_file')).rejects.toThrow();
    });
  });

  describe('Resources', () => {
    it('should expose local_file as supported resource', () => {
      expect(provider.resources).toContain('local_file');
    });
  });

  describe('random_string', () => {
    it('should validate length', async () => {
      await expect(provider.validate('random_string', { length: 10 })).resolves.not.toThrow();
      await expect(provider.validate('random_string', {})).rejects.toThrow();
      await expect(provider.validate('random_string', { length: 0 })).rejects.toThrow();
      await expect(provider.validate('random_string', { length: -5 })).rejects.toThrow();
    });

    it('should create a random string of specified length', async () => {
      const id = await provider.create('random_string', { length: 16 });
      expect(typeof id).toBe('string');
      expect(id).toHaveLength(16);
    });

    it('should create a random string with special characters', async () => {
      const id = await provider.create('random_string', { length: 50, special: true });
      expect(id).toHaveLength(50);
      const specialChars = '!@#$%^&*()_+-=[]{}|;:,.<>?';
      const hasSpecial = id.split('').some((char) => specialChars.includes(char));
      expect(hasSpecial).toBe(true);
    });

    it('should not update (no-op)', async () => {
      // Just ensure it doesn't throw
      await expect(provider.update('any-id', 'random_string', { length: 10 })).resolves.not.toThrow();
    });
  });

  describe('null_resource', () => {
    it('should validate anything', async () => {
      await expect(provider.validate('null_resource', { any: 'thing' })).resolves.not.toThrow();
    });

    it('should create and return a UUID', async () => {
      const id = await provider.create('null_resource', {});
      expect(id).toMatch(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i);
    });

    it('should not update (no-op)', async () => {
      await expect(provider.update('any-id', 'null_resource', {})).resolves.not.toThrow();
    });

    it('should not delete (no-op)', async () => {
      await expect(provider.delete('any-id', 'null_resource')).resolves.not.toThrow();
    });
  });

  describe('command_exec', () => {
    it('should validate command', async () => {
      await expect(provider.validate('command_exec', { command: 'echo hello' })).resolves.not.toThrow();
      await expect(provider.validate('command_exec', {})).rejects.toThrow();
    });

    it('should execute a command', async () => {
      const id = await provider.create('command_exec', { command: 'echo hello world' });
      expect(id).toBeDefined();
    });

    it('should execute a command with cwd', async () => {
      const id = await provider.create('command_exec', { command: 'pwd', cwd: '.' });
      expect(id).toBeDefined();
    });

    it('should fail if command fails', async () => {
      await expect(provider.create('command_exec', { command: 'exit 1' })).rejects.toThrow();
    });

    it('should re-execute on update', async () => {
      await expect(provider.update('any-id', 'command_exec', { command: 'echo updated' })).resolves.not.toThrow();
    });

    it('should not delete (no-op)', async () => {
      await expect(provider.delete('any-id', 'command_exec')).resolves.not.toThrow();
    });
  });

  describe('delete (generic)', () => {
    it('should not throw when deleting non-file resources', async () => {
      // Pass correct type, should be no-op for random_string
      await expect(provider.delete('some-random-id', 'random_string')).resolves.not.toThrow();
    });

    it('should throw for unknown types', async () => {
      await expect(provider.delete('id', 'unknown_type')).rejects.toThrow('Unsupported resource type');
    });
  });

  describe('getSchema', () => {
    it('should return schema for random_string', async () => {
      const schema = await provider.getSchema('random_string');
      expect(schema).toBeDefined();
      expect(schema.length).toBeDefined();
      expect(schema.length.forceNew).toBe(true);
    });

    it('should return schema for local_file', async () => {
      const schema = await provider.getSchema('local_file');
      expect(schema).toBeDefined();
      expect(schema.path).toBeDefined();
      expect(schema.path.forceNew).toBe(true);
    });

    it('should return schema for command_exec', async () => {
      const schema = await provider.getSchema('command_exec');
      expect(schema).toBeDefined();
      expect(schema.command).toBeDefined();
      expect(schema.command.forceNew).toBe(false);
    });

    it('should return schema for null_resource', async () => {
      const schema = await provider.getSchema('null_resource');
      expect(schema).toBeDefined();
      expect(Object.keys(schema)).toHaveLength(1);
      expect(schema.triggers).toBeDefined();
      expect(schema.triggers.type).toBe('map');
    });

    it('should throw for unknown types', async () => {
      await expect(provider.getSchema('unknown_type')).rejects.toThrow('Unsupported resource type');
    });
  });
});
