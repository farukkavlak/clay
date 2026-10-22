import { ExactNumber, types, UNKNOWN } from '@clay/contracts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalProvider } from '../src/index';

/** Whether the directory finds a file by a name in another case. */
async function ignoresCase(dir: string): Promise<boolean> {
  await fs.writeFile(path.join(dir, 'probe'), '', 'utf8');
  return fs.access(path.join(dir, 'PROBE')).then(
    () => true,
    () => false
  );
}

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

  /** As the engine calls it, with the plan equal to the configuration. */
  const create = (type: string, config: Record<string, unknown>) => provider.create(type, { config, planned: config });

  const identity = (values: Record<string, unknown>) => provider.identify('local_file', values);
  const named = async (values: Record<string, unknown>) => {
    const found = await identity(values);
    return found?.name;
  };
  const keyed = async (values: Record<string, unknown>) => {
    const found = await identity(values);
    return found?.key;
  };

  describe('Validation', () => {
    it('should validate local_file with path and content', async () => {
      await expect(
        provider.validate('local_file', {
          path: '/tmp/test.txt',
          content: 'Hello',
        })
      ).resolves.not.toThrow();
    });

    // The engine already checked names and types, so only rules a schema cannot express are left.
    it('should throw if path is empty', async () => {
      await expect(provider.validate('local_file', { path: '', content: 'Hello' })).rejects.toThrow('local_file "path" must not be empty');
    });

    it('should accept empty content and write an empty file', async () => {
      const filePath = path.join(tmpDir, 'empty.txt');
      await expect(provider.validate('local_file', { path: filePath, content: '' })).resolves.not.toThrow();

      await create('local_file', { path: filePath, content: '' });

      expect(await fs.readFile(filePath, 'utf8')).toBe('');
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

      await fs.writeFile(filePath, 'Original content', 'utf8');

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

      await fs.writeFile(filePath, 'Content', 'utf8');

      await expect(fs.access(filePath)).resolves.not.toThrow();

      await provider.delete('local_file', { id: filePath });

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

    // The id differs from the planned one, so the result must come from the plan.
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

      expect(schema[name]).toMatchObject({ type: types.string, computed: true, kept: true });
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

    it('plans a path spelled another way for the same file as an update, not a replace', async () => {
      const config = { path: './a.txt', content: 'hi' };
      const prior = { path: 'a.txt', content: 'hi', id: path.resolve('a.txt') };

      expect(await provider.plan('local_file', { prior, proposed: { ...config, id: prior.id }, config })).toEqual({ after: { ...config, id: prior.id }, replace: [] });
    });

    it.each([
      ['another file', 'b.txt', path.resolve('a.txt')],
      // A moved directory leaves the id where the file was made, which the new path no longer names.
      ['a spelling of the same path that no longer names the file of the id', './a.txt', '/old/a.txt'],
    ])('replaces a file whose new path is %s', async (_, file, id) => {
      const config = { path: file, content: 'hi' };
      const prior = { path: 'a.txt', content: 'hi', id };

      expect(await provider.plan('local_file', { prior, proposed: { ...config, id }, config })).toMatchObject({ replace: [['path']] });
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

    // A directory exists but is not a file, so the read fails with something other than ENOENT.
    it('still fails as the system says when the file cannot be read for another reason', async () => {
      await expect(provider.read('local_file', { id: tmpDir, path: tmpDir, content: '' })).rejects.toMatchObject({ code: 'EISDIR' });
    });

    // These exist only in state, so a read returns them as applied.
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

    // The data source only reads, so `content` is its only computed value.
    it('has a schema of its own, apart from the resource of the same type', async () => {
      expect(await provider.getDataSourceSchema('local_file')).toEqual({ path: { type: types.string, required: true }, content: { type: types.string, computed: true } });
    });

    it('refuses an empty path', async () => {
      await expect(provider.validateDataSource('local_file', { path: '' })).rejects.toThrow('local_file "path" must not be empty');
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

    // A directory exists but is not a file, so the read fails with something other than ENOENT.
    it('still fails as the system says when the file cannot be read for another reason', async () => {
      await expect(provider.readDataSource('local_file', { path: tmpDir })).rejects.toMatchObject({ code: 'EISDIR' });
    });

    it.each([
      ['described', (p: LocalProvider) => p.getDataSourceSchema('random_string')],
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

    it('takes a length that is not known yet, which the apply checks once it is', async () => {
      await expect(provider.validate('random_string', { length: UNKNOWN })).resolves.toBeUndefined();
    });

    // Numbers arrive exact, so a bad length is refused rather than rounded.
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
      await expect(provider.validate('command_exec', { command: '' })).rejects.toThrow('command_exec "command" must not be empty');
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

  describe('identify', () => {
    it('names a local_file by its full path, however the path is spelled', async () => {
      expect(await named({ path: './a.txt' })).toBe(`the file ${path.resolve('a.txt')}`);
    });

    // A delete removes the file the id names, which a moved directory leaves apart from the path.
    it('names a local_file by its id once it has one', async () => {
      expect(await named({ path: 'a.txt', id: '/old/a.txt' })).toBe('the file /old/a.txt');
    });

    it('names no local_file whose path is known only at apply', async () => {
      expect(await provider.identify('local_file', { path: UNKNOWN, id: UNKNOWN })).toBeUndefined();
    });

    it('names nothing for a resource that is no real thing', async () => {
      expect(await provider.identify('null_resource', { id: 'n' })).toBeUndefined();
    });

    describe('as the disk names it', () => {
      let real: string;

      beforeEach(async () => {
        // The temp directory may itself be reached through a link.
        real = await fs.realpath(tmpDir);
        await fs.mkdir(path.join(real, 'dir'));
        await fs.symlink(path.join(real, 'dir'), path.join(real, 'link'));
      });

      it('follows a link to a directory, to a file not made yet', async () => {
        expect(await named({ path: path.join(real, 'link', 'f.txt') })).toBe(`the file ${path.join(real, 'dir', 'f.txt')}`);
      });

      it('takes the case of a file that exists, where the file system ignores case', async (context) => {
        await fs.writeFile(path.join(real, 'dir', 'a.txt'), 'x', 'utf8');
        if (!(await ignoresCase(real))) context.skip();

        expect(await named({ path: path.join(real, 'dir', 'A.txt') })).toBe(`the file ${path.join(real, 'dir', 'a.txt')}`);
      });

      it('folds the case of parts not made yet, where the file system ignores case', async (context) => {
        if (!(await ignoresCase(real))) context.skip();

        expect(await keyed({ path: path.join(real, 'dir', 'New', 'A.txt') })).toBe(await keyed({ path: path.join(real, 'dir', 'new', 'a.txt') }));
        expect(await named({ path: path.join(real, 'dir', 'New', 'A.txt') })).toBe(`the file ${path.join(real, 'dir', 'New', 'A.txt')}`);
      });

      it('gives a file the key it had before it was made', async () => {
        const file = path.join(real, 'dir', 'New', 'A.txt');
        const before = await keyed({ path: file });
        await create('local_file', { path: file, content: 'x' });

        expect(await keyed({ path: file })).toBe(before);
      });

      it('folds parts not made yet as a file system that ignores case does', async (context) => {
        if (!(await ignoresCase(real))) context.skip();
        const identify = (name: string) => keyed({ path: path.join(real, 'dir', name) });

        expect(await identify('STRASSE')).toBe(await identify('Straße'));
        expect(await identify('ss')).toBe(await identify('ẞ'));
        expect(await identify('οδοσ')).toBe(await identify('ΟΔΟΣ'));
        expect(await identify('ı.txt')).not.toBe(await identify('i.txt'));
      });

      it('takes the case a link at the end has where its name folds to another length', async (context) => {
        await fs.symlink(path.join(real, 'dir', 'real.txt'), path.join(real, 'dir', 'STRASSE'));
        if (!(await ignoresCase(real))) context.skip();

        expect(await named({ path: path.join(real, 'dir', 'Straße') })).toBe(`the file ${path.join(real, 'dir', 'STRASSE')}`);
      });

      // `ı` turns into `I`, which finds nothing even where case is ignored, so it cannot tell.
      it('asks the directory above where no name in the directory turns into another case and back', async (context) => {
        if (!(await ignoresCase(real))) context.skip();
        await fs.writeFile(path.join(real, 'dir', 'ı'), 'x', 'utf8');

        expect(await keyed({ path: path.join(real, 'dir', 'A.txt') })).toBe(await keyed({ path: path.join(real, 'dir', 'a.txt') }));
      });

      it('asks the directory above one that cannot be listed', async (context) => {
        if (!(await ignoresCase(real))) context.skip();
        await fs.writeFile(path.join(real, 'dir', 'b.txt'), 'x', 'utf8');
        await fs.chmod(path.join(real, 'dir'), 0o300);

        try {
          expect(await keyed({ path: path.join(real, 'dir', 'A.txt') })).toBe(await keyed({ path: path.join(real, 'dir', 'a.txt') }));
        } finally {
          await fs.chmod(path.join(real, 'dir'), 0o700);
        }
      });

      it('keeps the case of parts not made yet, where the file system tells case apart', async (context) => {
        if (await ignoresCase(real)) context.skip();

        expect(await keyed({ path: path.join(real, 'dir', 'New', 'A.txt') })).not.toBe(await keyed({ path: path.join(real, 'dir', 'new', 'a.txt') }));
      });

      // Each name in the other case finds an entry, but not the same one.
      it('keeps the case of parts not made yet beside two files that differ only in case', async (context) => {
        if (await ignoresCase(real)) context.skip();
        await fs.writeFile(path.join(real, 'dir', 'B.txt'), 'x', 'utf8');
        await fs.writeFile(path.join(real, 'dir', 'b.TXT'), 'x', 'utf8');

        expect(await keyed({ path: path.join(real, 'dir', 'New', 'A.txt') })).not.toBe(await keyed({ path: path.join(real, 'dir', 'new', 'a.txt') }));
      });

      // A delete unlinks the link and leaves what it points to, so the two are not one file.
      it('names a link at the end of the path as itself', async () => {
        await fs.writeFile(path.join(real, 'dir', 'real.txt'), 'x', 'utf8');
        await fs.symlink(path.join(real, 'dir', 'real.txt'), path.join(real, 'dir', 'l.txt'));

        expect(await named({ path: path.join(real, 'link', 'l.txt') })).toBe(`the file ${path.join(real, 'dir', 'l.txt')}`);
      });

      it('takes the case a link at the end has, where the file system ignores case', async (context) => {
        await fs.symlink(path.join(real, 'dir', 'real.txt'), path.join(real, 'dir', 'L.txt'));
        if (!(await ignoresCase(real))) context.skip();

        expect(await named({ path: path.join(real, 'dir', 'l.txt') })).toBe(`the file ${path.join(real, 'dir', 'L.txt')}`);
      });

      it('names a path under a file as written', async () => {
        await fs.writeFile(path.join(real, 'dir', 'f.txt'), 'x', 'utf8');

        expect(await named({ path: path.join(real, 'link', 'f.txt', 'x') })).toBe(`the file ${path.join(real, 'dir', 'f.txt', 'x')}`);
      });

      it('fails on a path the disk cannot follow', async () => {
        await fs.symlink('loop', path.join(real, 'loop'));

        await expect(provider.identify('local_file', { path: path.join(real, 'loop', 'f.txt') })).rejects.toThrow('ELOOP');
      });

      it('plans a path in another case to a file removed by hand as an update, where the file system ignores case', async (context) => {
        if (!(await ignoresCase(real))) context.skip();
        const config = { path: path.join(real, 'dir', 'A.txt'), content: 'hi' };
        const prior = { path: path.join(real, 'dir', 'a.txt'), content: 'hi', id: path.join(real, 'dir', 'a.txt') };

        expect(await provider.plan('local_file', { prior, proposed: { ...config, id: prior.id }, config })).toMatchObject({ replace: [] });
      });

      it('plans a path through a link to the file the id is as an update', async () => {
        const config = { path: path.join(real, 'link', 'a.txt'), content: 'hi' };
        const prior = { path: path.join(real, 'dir', 'a.txt'), content: 'hi', id: path.join(real, 'dir', 'a.txt') };
        await fs.writeFile(prior.id, 'hi', 'utf8');

        expect(await provider.plan('local_file', { prior, proposed: { ...config, id: prior.id }, config })).toMatchObject({ replace: [] });
      });
    });
  });

  describe('delete (generic)', () => {
    it('should not throw when deleting non-file resources', async () => {
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
        id: { type: types.string, computed: true, kept: true },
        triggers: { type: types.map(types.dynamic), required: false },
      });
    });

    it('should throw for unknown types', async () => {
      await expect(provider.getSchema('unknown_type')).rejects.toThrow('Unsupported resource type');
    });
  });
});
