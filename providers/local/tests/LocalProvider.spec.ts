import { ExactNumber, UNKNOWN } from '@clay/contracts';
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

  /** A create as the engine asks for one, where the plan holds what the configuration sets. */
  const create = (type: string, config: Record<string, unknown>) => provider.create(type, { config, planned: config });

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

      await create('local_file', { path: filePath, content: '' });

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

      const { id } = await create('local_file', {
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

      await create('local_file', {
        path: filePath,
        content,
      });

      const fileContent = await fs.readFile(filePath, 'utf8');
      expect(fileContent).toBe(content);
    });

    it('should throw for unsupported resource type', async () => {
      await expect(
        create('unknown_type', {
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
      const config = { path: filePath, content: 'Updated content' };
      await provider.update('local_file', { prior: { id: filePath, path: filePath, content: 'Original content' }, config, planned: { ...config, id: filePath } });

      const fileContent = await fs.readFile(filePath, 'utf8');
      expect(fileContent).toBe('Updated content');
    });

    it('should throw for unsupported resource type', async () => {
      await expect(provider.update('unknown_type', { prior: { id: '/tmp/test.txt' }, config: { content: 'Hello' }, planned: { content: 'Hello' } })).rejects.toThrow(
        'Unsupported resource type'
      );
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
      await provider.delete('local_file', { id: filePath });

      // Verify it's gone
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('treats a file that is already gone as deleted', async () => {
      await expect(provider.delete('local_file', { id: path.join(tmpDir, 'gone.txt') })).resolves.toBeUndefined();
    });

    it('still fails when the file cannot be removed for another reason', async () => {
      // A directory is not a file, so unlink refuses it with something other than ENOENT.
      await expect(provider.delete('local_file', { id: tmpDir })).rejects.toThrow();
    });
  });

  describe('a resource that holds no id', () => {
    it.each([
      ['read', () => provider.read('local_file', { path: 'a.txt', content: '' })],
      ['update', () => provider.update('local_file', { prior: { path: 'a.txt', content: '' }, config: { path: 'a.txt', content: 'x' }, planned: { path: 'a.txt', content: 'x' } })],
      ['delete', () => provider.delete('local_file', { path: 'a.txt', content: '' })],
    ])('is refused on a %s, since there is nothing to find it by', async (_, call) => {
      await expect(call()).rejects.toThrow('the resource holds no id to find it by');
    });
  });

  describe('what create and update return', () => {
    it.each([
      ['local_file', () => ({ path: path.join(tmpDir, 'made.txt'), content: 'hi' })],
      ['null_resource', () => ({ triggers: { a: 'b' } })],
      ['random_string', () => ({ length: ExactNumber.parse('4') })],
      ['command_exec', () => ({ command: 'echo hi' })],
    ])('makes %s from what the plan says, not only from the configuration', async (type, configOf) => {
      const config = configOf();

      const created = await provider.create(type, { config, planned: { ...config, from: 'plan' } });

      expect(created).toMatchObject({ ...config, from: 'plan' });
    });

    // The id it was made with differs from the one planned, so only the plan can give what is returned.
    it.each([
      ['null_resource', { triggers: { a: 'c' } }, { id: 'from-plan' }, {}],
      ['random_string', { length: ExactNumber.parse('4') }, { id: 'from-plan', result: 'from-plan' }, {}],
      ['command_exec', { command: 'echo b' }, { id: 'from-plan', stdout: UNKNOWN }, { stdout: 'b\n' }],
    ])('returns what the plan says %s holds on an update, with what only the apply makes', async (type, config, computed, made) => {
      const planned = { ...config, ...computed };

      const updated = await provider.update(type, { prior: { id: 'made', result: 'made' }, config, planned });

      expect(updated).toEqual({ ...planned, ...made });
    });

    it('writes a file found by the id it holds, and returns what the plan says', async () => {
      const file = path.join(tmpDir, 'made.txt');
      const config = { path: file, content: 'changed' };
      await fs.writeFile(file, 'hi', 'utf8');

      const updated = await provider.update('local_file', { prior: { path: file, content: 'hi', id: file }, config, planned: { ...config, id: 'from-plan' } });

      expect(updated).toEqual({ ...config, id: 'from-plan' });
      expect(await fs.readFile(file, 'utf8')).toBe('changed');
    });
  });

  describe('what the provider computes', () => {
    it.each([
      ['random_string', 'result'],
      ['command_exec', 'stdout'],
      ['local_file', 'id'],
      ['random_string', 'id'],
      ['null_resource', 'id'],
      ['command_exec', 'id'],
    ])('marks %s %s as computed', async (type, name) => {
      const schema = await provider.getSchema(type);

      expect(schema[name]).toMatchObject({ computed: true });
    });

    it.each([
      ['local_file', 'id'],
      ['random_string', 'id'],
      ['random_string', 'result'],
      ['null_resource', 'id'],
      ['command_exec', 'id'],
    ])('keeps %s %s until it is replaced', async (type, name) => {
      const schema = await provider.getSchema(type);

      expect(schema[name]).toEqual({ type: 'string', computed: true, kept: true });
    });

    it('returns the string it made as result, which is its id too', async () => {
      const inputs = { length: ExactNumber.parse('6') };

      const created = await create('random_string', inputs);

      expect(created).toEqual({ ...inputs, id: created.result, result: created.result });
      expect(created.result).toHaveLength(6);
    });

    it('plans the id of a file to make as the path it is written to, which create returns', async () => {
      const config = { path: path.join(tmpDir, 'sub', '..', 'a.txt'), content: 'hi' };

      const { after } = await provider.plan('local_file', { prior: null, proposed: config, config });

      expect(after.id).toBe(path.join(tmpDir, 'a.txt'));
      expect(await provider.create('local_file', { config, planned: after })).toEqual(after);
    });

    it.each([
      ['its path is not known', UNKNOWN],
      ['its path is relative, since it lands where the apply runs', 'a.txt'],
    ])('plans the id of a file as not known while %s', async (_, file) => {
      const config = { path: file, content: 'hi' };

      expect(await provider.plan('local_file', { prior: null, proposed: config, config })).toEqual({ after: { ...config, id: UNKNOWN }, replace: [] });
    });

    it('plans an update of a file with the id it already holds', async () => {
      const config = { path: path.join(tmpDir, 'a.txt'), content: 'changed' };
      const prior = { path: config.path, content: 'hi', id: '/where/it/was/made' };

      const { after } = await provider.plan('local_file', { prior, proposed: { ...config, id: prior.id }, config });

      expect(after.id).toBe('/where/it/was/made');
    });

    it('returns what a command printed, on create and on the run an update makes', async () => {
      const created = await create('command_exec', { command: 'echo made' });
      const config = { command: 'echo changed' };
      const updated = await provider.update('command_exec', { prior: created, config, planned: { ...config, id: created.id, stdout: UNKNOWN } });

      expect(created).toEqual({ id: created.id, command: 'echo made', stdout: 'made\n' });
      expect(updated).toEqual({ id: created.id, command: 'echo changed', stdout: 'changed\n' });
    });
  });

  describe('READ', () => {
    it('reads a file as it is on disk now, keeping its path', async () => {
      const filePath = path.join(tmpDir, 'drift.txt');
      const created = await create('local_file', { path: filePath, content: 'applied' });
      await fs.writeFile(filePath, 'changed by hand', 'utf8');

      expect(await provider.read('local_file', created)).toEqual({ id: created.id, path: filePath, content: 'changed by hand' });
    });

    it('reads a file that is gone as nothing', async () => {
      const filePath = path.join(tmpDir, 'gone.txt');
      const created = await create('local_file', { path: filePath, content: 'applied' });
      await fs.unlink(filePath);

      expect(await provider.read('local_file', created)).toBeNull();
    });

    // A directory is there but is not a file, so reading it fails with something other than ENOENT.
    it('still fails as the system says when the file cannot be read for another reason', async () => {
      await expect(provider.read('local_file', { id: tmpDir, path: tmpDir, content: '' })).rejects.toMatchObject({ code: 'EISDIR' });
    });

    // Nothing outside the state says what these hold, so what was applied is what they are.
    it.each([
      ['random_string', { length: ExactNumber.parse('4') }],
      ['null_resource', { triggers: { a: 'b' } }],
      ['command_exec', { command: 'echo hi' }],
    ])('reads %s as it was applied', async (type, prior) => {
      expect(await provider.read(type, prior)).toEqual(prior);
    });

    it('refuses a type it does not make', async () => {
      await expect(provider.read('unknown_type', {})).rejects.toThrow('Unsupported resource type');
    });
  });

  describe('Resources', () => {
    it('should expose local_file as supported resource', () => {
      expect(provider.resources).toContain('local_file');
    });
  });

  describe('the local_file data source', () => {
    it('reads local_file, and no other type, as a data source', () => {
      expect(provider.dataSources).toEqual(['local_file']);
    });

    it('takes a path without content, which only a file to write needs', async () => {
      await expect(provider.validateDataSource('local_file', { path: 'a.txt' })).resolves.toBeUndefined();
    });

    it.each([
      ['no path', {}],
      ['a path that is not a string', { path: 1 }],
    ])('refuses %s', async (_, inputs) => {
      await expect(provider.validateDataSource('local_file', inputs)).rejects.toThrow('local_file requires "path" attribute (string)');
    });

    it('reads the content of the file', async () => {
      const filePath = path.join(tmpDir, 'read.txt');
      await fs.writeFile(filePath, 'héllo', 'utf8');

      expect(await provider.readDataSource('local_file', { path: filePath })).toEqual({ content: 'héllo' });
    });

    it('refuses a file that is not there', async () => {
      const filePath = path.join(tmpDir, 'missing.txt');

      await expect(provider.readDataSource('local_file', { path: filePath })).rejects.toMatchObject({
        message: `local_file cannot read "${filePath}": there is no such file`,
        cause: { code: 'ENOENT' },
      });
    });

    // A directory is there but is not a file, so reading it fails with something other than ENOENT.
    it('still fails as the system says when the file cannot be read for another reason', async () => {
      await expect(provider.readDataSource('local_file', { path: tmpDir })).rejects.toMatchObject({ code: 'EISDIR' });
    });

    it.each([
      ['validated', (p: LocalProvider) => p.validateDataSource('random_string', {})],
      ['read', (p: LocalProvider) => p.readDataSource('random_string', {})],
    ])('refuses to be %s as a type it only makes as a resource', async (_, call) => {
      await expect(call(provider)).rejects.toThrow('Unsupported data source type: random_string');
    });
  });

  describe('random_string', () => {
    it('should validate length', async () => {
      await expect(provider.validate('random_string', { length: ExactNumber.parse('10') })).resolves.not.toThrow();
      await expect(provider.validate('random_string', {})).rejects.toThrow();
      await expect(provider.validate('random_string', { length: ExactNumber.parse('0') })).rejects.toThrow();
      await expect(provider.validate('random_string', { length: ExactNumber.parse('-5') })).rejects.toThrow();
    });

    // A number reaches a provider exactly, and a length is refused rather than rounded or cut to fit.
    it.each([
      ['a length that is not whole', ExactNumber.parse('1.5'), 'random_string "length": 1.5 is not a whole number'],
      [
        'a length JavaScript would round',
        ExactNumber.parse('9007199254740993'),
        'random_string "length": 9007199254740993 is outside the range -9007199254740991 to 9007199254740991',
      ],
      ['a length that is a JavaScript number', 10, 'random_string requires "length" attribute (number > 0)'],
    ])('refuses %s', async (_, length, message) => {
      await expect(provider.validate('random_string', { length })).rejects.toThrow(message);
    });

    it('should create a random string of specified length', async () => {
      const { id } = await create('random_string', { length: ExactNumber.parse('16') });
      expect(typeof id).toBe('string');
      expect(id).toHaveLength(16);
    });

    it('should create a random string with special characters', async () => {
      const { id } = await create('random_string', { length: ExactNumber.parse('50'), special: true });
      expect(id).toHaveLength(50);
      const specialChars = '!@#$%^&*()_+-=[]{}|;:,.<>?';
      const hasSpecial = [...String(id)].some((char) => specialChars.includes(char));
      expect(hasSpecial).toBe(true);
    });
  });

  describe('null_resource', () => {
    it('should validate anything', async () => {
      await expect(provider.validate('null_resource', { any: 'thing' })).resolves.not.toThrow();
    });

    it('should create and return a UUID', async () => {
      const { id } = await create('null_resource', {});
      expect(id).toMatch(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i);
    });

    it('should not delete (no-op)', async () => {
      await expect(provider.delete('null_resource', { id: 'any-id' })).resolves.not.toThrow();
    });
  });

  describe('command_exec', () => {
    it('should validate command', async () => {
      await expect(provider.validate('command_exec', { command: 'echo hello' })).resolves.not.toThrow();
      await expect(provider.validate('command_exec', {})).rejects.toThrow();
    });

    it('should execute a command', async () => {
      const attributes = await create('command_exec', { command: 'echo hello world' });
      expect(attributes.stdout).toBe('hello world\n');
    });

    it('should execute a command with cwd', async () => {
      const attributes = await create('command_exec', { command: 'pwd', cwd: tmpDir });
      expect(await fs.realpath(String(attributes.stdout).trim())).toBe(await fs.realpath(tmpDir));
    });

    it('should fail if command fails', async () => {
      await expect(create('command_exec', { command: 'exit 1' })).rejects.toThrow();
    });

    it('should not delete (no-op)', async () => {
      await expect(provider.delete('command_exec', { id: 'any-id' })).resolves.not.toThrow();
    });
  });

  describe('delete (generic)', () => {
    it('should not throw when deleting non-file resources', async () => {
      // Pass correct type, should be no-op for random_string
      await expect(provider.delete('random_string', { id: 'some-random-id' })).resolves.not.toThrow();
    });

    it('should throw for unknown types', async () => {
      await expect(provider.delete('unknown_type', { id: 'id' })).rejects.toThrow('Unsupported resource type');
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
      expect(await provider.getSchema('null_resource')).toEqual({
        id: { type: 'string', computed: true, kept: true },
        triggers: { type: 'map', elemType: 'string', required: false },
      });
    });

    it('should throw for unknown types', async () => {
      await expect(provider.getSchema('unknown_type')).rejects.toThrow('Unsupported resource type');
    });
  });
});
