import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpStateServer } from '../../../tests/httpStateServer';
import { adoptBackend, checkBackend, LocalBackend } from '../src';
import { backendAt } from './backendAt';

describe('the backend init remembers', () => {
  let dir: string;

  const recordPath = () => path.join(dir, '.clay', 'backend.json');
  const write = (content: unknown) => fs.writeFile(recordPath(), JSON.stringify(content), 'utf8');
  const recorded = async (): Promise<unknown> => JSON.parse(await fs.readFile(recordPath(), 'utf8'));

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-remembered-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is not taken while a journal alone is left at the old place', async () => {
    await fs.writeFile(path.join(dir, 'clay.state.json.journal'), 'line\n', 'utf8');

    await expect(adoptBackend(new LocalBackend(dir, 'other.json'), dir)).rejects.toThrow('The state in "clay.state.json" would be left behind');
    await expect(fs.access(path.join(dir, '.clay'))).rejects.toThrow('ENOENT');
  });

  it('leaves only the record behind it', async () => {
    await adoptBackend(new LocalBackend(dir, 'other.json'), dir);

    expect(await fs.readdir(path.join(dir, '.clay'))).toEqual(['backend.json']);
    expect(() => checkBackend(new LocalBackend(dir, 'other.json'), dir)).not.toThrow();
    expect(() => checkBackend(new LocalBackend(dir), dir)).toThrow('keeps its state in "other.json"');
  });

  it('records every setting, and nothing else', async () => {
    await adoptBackend(new LocalBackend(dir, 'other.json'), dir);

    expect(await recorded()).toEqual({ type: 'local', settings: { path: 'other.json' } });
  });

  it.each([
    ['no JSON', 'nope'],
    ['the place alone, as an older init wrote it', { type: 'local', where: 'other.json' }],
    ['a key beside the type and the settings', { type: 'local', settings: {}, where: 'other.json' }],
    ['settings that are no object', { type: 'local', settings: ['other.json'] }],
    ['a setting that is no string', { type: 'local', settings: { path: 1 } }],
    ['an empty setting', { type: 'local', settings: { path: '' } }],
    ['a setting the backend does not take', { type: 'local', settings: { path: 'other.json', mode: 'x' } }],
    ['configuration as the state', { type: 'local', settings: { path: 'main.clay' } }],
    ['a type Clay does not have', { type: 's3', settings: {} }],
  ])('is refused where the record holds %s', async (_title, content) => {
    await fs.mkdir(path.join(dir, '.clay'));
    await (typeof content === 'string' ? fs.writeFile(recordPath(), content, 'utf8') : write(content));

    expect(() => checkBackend(new LocalBackend(dir), dir)).toThrow(`${recordPath()} is not what \`clay init\` writes; remove it and run \`clay init\``);
  });

  it('passes on a record it cannot read, rather than taking it as no record', async () => {
    await fs.mkdir(path.join(dir, '.clay', 'backend.json'), { recursive: true });

    expect(() => checkBackend(new LocalBackend(dir), dir)).toThrow('EISDIR');
  });

  it('passes on a place it cannot ask about, rather than taking it as nothing there', async () => {
    await expect(new LocalBackend(dir, 'x'.repeat(300)).check()).rejects.toThrow('ENAMETOOLONG');
  });

  describe('on an HTTP server', () => {
    let server: HttpStateServer;

    const backendOn = (name: string) => backendAt(server.url, {}, name);
    const record = (settings: Record<string, string>) => write({ type: 'http', settings: { ...backendOn('state').choice.settings, ...settings } });

    beforeEach(async () => {
      server = await HttpStateServer.start();
      await fs.mkdir(path.join(dir, '.clay'));
    });

    afterEach(async () => {
      await server.stop();
    });

    it('is remembered by its address', async () => {
      await adoptBackend(backendOn('state'), dir);

      expect(() => checkBackend(backendOn('state'), dir)).not.toThrow();
      expect(() => checkBackend(backendOn('other'), dir)).toThrow(`keeps its state in "${server.url}/state" (http), and the configuration names "${server.url}/other" (http)`);
    });

    it('is built again with the settings the record holds', async () => {
      await adoptBackend(backendAt(server.url, { lock: 'POST' }), dir);

      expect(() => checkBackend(backendOn('state'), dir)).toThrow(
        'lock_method of backend "http" is "LOCK" in the configuration, and "POST" where `clay init` took it; run `clay init`'
      );
    });

    it('is refused where the record leaves out an address the backend needs', async () => {
      await write({ type: 'http', settings: { address: `${server.url}/state` } });

      expect(() => checkBackend(backendOn('state'), dir)).toThrow('is not what `clay init` writes');
    });

    it('takes other settings for the same place while the server holds a state', async () => {
      server.state = '{}';
      await adoptBackend(backendOn('state'), dir);

      await adoptBackend(backendAt(server.url, { lock: 'POST' }), dir);

      expect(await recorded()).toMatchObject({ settings: { lock_method: 'POST' } });
      expect(() => checkBackend(backendAt(server.url, { lock: 'POST' }), dir)).not.toThrow();
    });

    it('is not left for another place while the server holds a state', async () => {
      server.state = '{}';
      await record({});

      await expect(adoptBackend(new LocalBackend(dir), dir)).rejects.toThrow(
        `The state in "${server.url}/state" would be left behind, as the configuration names "clay.state.json"; move it there by hand, or remove it, and run \`clay init\` again`
      );
    });

    it('is left for another place once the server holds none', async () => {
      await record({});

      await adoptBackend(new LocalBackend(dir), dir);

      expect(() => checkBackend(new LocalBackend(dir), dir)).not.toThrow();
      expect(server.received.map(({ method, path: at }) => `${method} ${at}`)).toEqual(['GET /state']);
    });

    it.each([
      ['no URL', 'nowhere'],
      ['another scheme', 'file:///state'],
      ['credentials', 'https://me:secret@state.example/s'],
    ])('is refused where the record names %s', async (_title, where) => {
      await record({ address: where });

      expect(() => checkBackend(new LocalBackend(dir), dir)).toThrow('is not what `clay init` writes');
    });

    it('names the way out where the old server gives no answer', async () => {
      const gone = await HttpStateServer.start();
      const { url } = gone;
      await gone.stop();
      await record({ address: `${url}/state` });

      await expect(adoptBackend(new LocalBackend(dir), dir)).rejects.toThrow(
        `GET ${url}/state got no answer (ECONNREFUSED), so whether a state is left there is not known. If that server is gone for good, remove ${path.join(dir, '.clay', 'backend.json')} and run \`clay init\` again`
      );
    });
  });
});
