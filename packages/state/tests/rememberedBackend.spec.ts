import { emptyState, State } from '@clay/contracts';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpStateServer } from '../../../tests/httpStateServer';
import { adoptBackend, Approve, checkBackend, LocalBackend, LockNotReleased, newLockInfo, rememberedBackend, serializeState, StateLocked, StateManager } from '../src';
import { backendAt, ONCE } from './backendAt';

/** For a call that must not ask. */
const unasked: Approve = () => {
  throw new Error('asked');
};
const yes: Approve = async () => true;

const holding = (name: string, serial = 3): State => ({ ...emptyState(), serial, resources: { [`rt.${name}`]: { resourceType: 'rt', name, attributes: {} } } });

describe('the backend init remembers', () => {
  let dir: string;

  const recordPath = () => path.join(dir, '.clay', 'backend.json');
  const write = (content: unknown) => fs.writeFile(recordPath(), JSON.stringify(content), 'utf8');
  const recorded = async (): Promise<unknown> => JSON.parse(await fs.readFile(recordPath(), 'utf8'));
  const previous = () => {
    const backend = rememberedBackend(dir, {});
    return { backend, manager: new StateManager(backend) };
  };
  const old = () => new LocalBackend(dir);
  const other = () => new LocalBackend(dir, 'other.json');
  const exists = (name: string) =>
    fs.access(path.join(dir, name)).then(
      () => true,
      () => false
    );

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-remembered-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('leaves only the record behind it', async () => {
    await adoptBackend(new LocalBackend(dir, 'other.json'), previous(), dir, unasked);

    expect(await fs.readdir(path.join(dir, '.clay'))).toEqual(['backend.json']);
    expect(() => checkBackend(new LocalBackend(dir, 'other.json'), dir, {})).not.toThrow();
    expect(() => checkBackend(new LocalBackend(dir), dir, {})).toThrow('keeps its state in "other.json"');
  });

  it('records every setting, and nothing else', async () => {
    await adoptBackend(new LocalBackend(dir, 'other.json'), previous(), dir, unasked);

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

    expect(() => checkBackend(new LocalBackend(dir), dir, {})).toThrow(`${recordPath()} is not what \`clay init\` writes; remove it and run \`clay init\``);
  });

  it('passes on a record it cannot read, rather than taking it as no record', async () => {
    await fs.mkdir(path.join(dir, '.clay', 'backend.json'), { recursive: true });

    expect(() => checkBackend(new LocalBackend(dir), dir, {})).toThrow('EISDIR');
  });

  it('passes on a place it cannot ask about, rather than taking it as nothing there', async () => {
    await expect(new LocalBackend(dir, 'x'.repeat(300)).check()).rejects.toThrow('ENAMETOOLONG');
  });

  describe('on an HTTP server', () => {
    let server: HttpStateServer;

    const backendOn = (name: string) => backendAt(server.url, {}, name);
    const record = (settings: Record<string, unknown>) => write({ type: 'http', settings: { ...backendOn('state').choice.settings, ...settings } });

    beforeEach(async () => {
      server = await HttpStateServer.start();
      await fs.mkdir(path.join(dir, '.clay'));
    });

    afterEach(async () => {
      await server.stop();
    });

    it('is remembered by its address', async () => {
      await adoptBackend(backendOn('state'), previous(), dir, unasked);

      expect(() => checkBackend(backendOn('state'), dir, {})).not.toThrow();
      expect(() => checkBackend(backendOn('other'), dir, {})).toThrow(`keeps its state in "${server.url}/state" (http), and the configuration names "${server.url}/other" (http)`);
    });

    it('is built again with the settings the record holds', async () => {
      await adoptBackend(backendAt(server.url, { lock: 'POST' }), previous(), dir, unasked);

      expect(() => checkBackend(backendOn('state'), dir, {})).toThrow(
        'lock_method of backend "http" is "LOCK" in the configuration, and "POST" where `clay init` took it; run `clay init`'
      );
    });

    it('is built again with how the record tries a request again', async () => {
      await adoptBackend(backendAt(server.url, {}, 'state', { ...ONCE, max: 4 }), previous(), dir, unasked);

      expect(() => checkBackend(backendOn('state'), dir, {})).toThrow('retry_max of backend "http" is 0 in the configuration, and 4 where `clay init` took it; run `clay init`');
    });

    it.each([
      ['a string', '2'],
      ['a fraction', 1.5],
      ['fewer than no tries', -1],
    ])('is refused where the record holds %s for retry_max', async (_title, value) => {
      await record({ retry_max: value });

      expect(() => checkBackend(new LocalBackend(dir), dir, {})).toThrow('is not what `clay init` writes');
    });

    it('is refused where the record leaves out an address the backend needs', async () => {
      await write({ type: 'http', settings: { address: `${server.url}/state` } });

      expect(() => checkBackend(backendOn('state'), dir, {})).toThrow('is not what `clay init` writes');
    });

    it('takes other settings for the same place while the server holds a state', async () => {
      server.state = '{}';
      await adoptBackend(backendOn('state'), previous(), dir, unasked);

      await adoptBackend(backendAt(server.url, { lock: 'POST' }), previous(), dir, unasked);

      expect(await recorded()).toMatchObject({ settings: { lock_method: 'POST' } });
      expect(() => checkBackend(backendAt(server.url, { lock: 'POST' }), dir, {})).not.toThrow();
    });

    it('moves its state to a file, and keeps it on the server', async () => {
      server.state = serializeState(holding('a'));
      await record({});

      expect(await adoptBackend(new LocalBackend(dir), previous(), dir, yes)).toMatchObject({ moved: { copied: true, from: { where: `${server.url}/state` } } });

      expect(await new LocalBackend(dir).read()).toEqual(holding('a'));
      expect(server.state).toBe(serializeState(holding('a')));
      expect(server.lock).toBeUndefined();
      expect(() => checkBackend(new LocalBackend(dir), dir, {})).not.toThrow();
    });

    it('takes a file state to the server', async () => {
      await new StateManager(new LocalBackend(dir)).write(holding('a', 2));

      await adoptBackend(backendOn('state'), previous(), dir, yes);

      expect(JSON.parse(server.state!)).toEqual(holding('a'));
      expect(() => checkBackend(backendOn('state'), dir, {})).not.toThrow();
    });

    it('says the old lock is left once the state has moved, and keeps the record', async () => {
      server.state = serializeState(holding('a'));
      await record({});
      server.override('UNLOCK /lock', { status: 500 });

      const { lockLeft } = await adoptBackend(new LocalBackend(dir), previous(), dir, yes);

      expect(lockLeft).toBeInstanceOf(LockNotReleased);
      expect(lockLeft?.message).toContain(`UNLOCK ${server.url}/lock`);
      expect(await new LocalBackend(dir).read()).toEqual(holding('a'));
      expect(() => checkBackend(new LocalBackend(dir), dir, {})).not.toThrow();
    });

    it('is left for another place where its state is gone once locked', async () => {
      await record({});
      server.override('GET /state', { status: 200, body: serializeState(holding('a')) });

      expect(await adoptBackend(new LocalBackend(dir), previous(), dir, unasked)).toEqual({});

      expect(() => checkBackend(new LocalBackend(dir), dir, {})).not.toThrow();
      expect(server.lock).toBeUndefined();
    });

    it('moves to another address on the server under the one lock they share', async () => {
      server.state = serializeState(holding('a'));
      await record({});
      const backend = backendOn('other');
      await backend.lock(newLockInfo('init'));

      expect(await adoptBackend(backend, previous(), dir, yes)).toEqual({ moved: { from: backendOn('state').choice, copied: true } });

      expect(JSON.parse(server.other!)).toEqual(holding('a'));
      expect(server.received.filter(({ method }) => method === 'LOCK')).toHaveLength(1);
    });

    it('keeps the refusal beside a lock it could not release', async () => {
      server.state = serializeState(holding('a'));
      await record({});
      await new StateManager(new LocalBackend(dir)).write(holding('b'));
      server.override('UNLOCK /lock', { status: 500 });

      const refused = adoptBackend(new LocalBackend(dir), previous(), dir, unasked);

      await expect(refused).rejects.toThrow(AggregateError);
      await expect(refused).rejects.toMatchObject({ errors: [{ message: expect.stringContaining('both hold a state') }, expect.any(LockNotReleased)] });
      expect(await recorded()).toMatchObject({ type: 'http' });
    });

    it('is left for another place once the server holds none', async () => {
      await record({});

      await adoptBackend(new LocalBackend(dir), previous(), dir, unasked);

      expect(() => checkBackend(new LocalBackend(dir), dir, {})).not.toThrow();
      expect(server.received.map(({ method, path: at }) => `${method} ${at}`)).toEqual(['GET /state']);
    });

    it.each([
      ['no URL', 'nowhere'],
      ['another scheme', 'file:///state'],
      ['credentials', 'https://me:secret@state.example/s'],
    ])('is refused where the record names %s', async (_title, where) => {
      await record({ address: where });

      expect(() => checkBackend(new LocalBackend(dir), dir, {})).toThrow('is not what `clay init` writes');
    });

    it('is refused where the record holds a password', async () => {
      await record({ password: 'secret' });

      expect(() => checkBackend(new LocalBackend(dir), dir, {})).toThrow('is not what `clay init` writes');
    });

    it('names the way out where the old server gives no answer', async () => {
      const gone = await HttpStateServer.start();
      const { url } = gone;
      await gone.stop();
      await record({ address: `${url}/state` });

      await expect(adoptBackend(new LocalBackend(dir), previous(), dir, unasked)).rejects.toThrow(
        `GET ${url}/state got no answer (ECONNREFUSED). Whether a state is left there is not known; if that server is gone for good, remove ${path.join(dir, '.clay', 'backend.json')} and run \`clay init\` again`
      );
    });

    it('names the way out where the old server fails the TLS handshake', async () => {
      const untrusted = await HttpStateServer.start({ tls: true });
      const { url } = untrusted;
      await record({ address: `${url}/state` });

      await expect(adoptBackend(new LocalBackend(dir), previous(), dir, unasked)).rejects.toThrow(
        `GET ${url}/state failed the TLS handshake (UNABLE_TO_VERIFY_LEAF_SIGNATURE); name the CA that signed its certificate in ca_certificate of the backend block. Whether a state is left there is not known; if that server is gone for good, remove ${path.join(dir, '.clay', 'backend.json')} and run \`clay init\` again`
      );
      await untrusted.stop();
    });
  });

  describe('a state at the old place', () => {
    it('is moved once asked, with what its journal holds, and the old one is kept', async () => {
      const manager = new StateManager(old());
      const state = holding('a');
      await manager.write(state);
      state.resources['rt.b'] = { resourceType: 'rt', name: 'b', attributes: {} };
      await manager.record(state, 'rt.b');
      const approve = vi.fn(yes);

      expect(await adoptBackend(other(), previous(), dir, approve)).toEqual({ moved: { from: old().choice, copied: true } });

      expect(approve).toHaveBeenCalledWith('Move the state in "clay.state.json" (local) to "other.json" (local)?');
      expect(await other().read()).toEqual(state);
      expect(await old().read()).toEqual(state);
      expect(await exists('clay.state.json.journal')).toBe(true);
      expect(() => checkBackend(other(), dir, {})).not.toThrow();
    });

    it('is asked about under the lock of the old place, which is then released', async () => {
      await new StateManager(old()).write(holding('a'));
      let lockedWhileAsked = false;

      await adoptBackend(other(), previous(), dir, async () => {
        lockedWhileAsked = await exists('clay.state.json.lock');
        return true;
      });

      expect(lockedWhileAsked).toBe(true);
      expect(await exists('clay.state.json.lock')).toBe(false);
    });

    it('is left where it is, with nothing written, when the answer is no', async () => {
      await new StateManager(old()).write(holding('a'));

      await expect(adoptBackend(other(), previous(), dir, async () => false)).rejects.toThrow('The state was not moved, and nothing changed');

      expect(await exists('other.json')).toBe(false);
      expect(await exists('.clay')).toBe(false);
      expect(await exists('clay.state.json.lock')).toBe(false);
    });

    it('is not moved while another run holds the old lock', async () => {
      await new StateManager(old()).write(holding('a'));
      await old().lock(newLockInfo('apply'));

      await expect(adoptBackend(other(), previous(), dir, unasked)).rejects.toThrow(StateLocked);

      expect(await exists('other.json')).toBe(false);
      expect(await exists('.clay')).toBe(false);
    });

    it('has its old lock taken as a step the caller can stop', async () => {
      await new StateManager(old()).write(holding('a'));
      const stopped = new Error('stopped at the lock');
      const steps: boolean[] = [];

      const adopting = adoptBackend(other(), previous(), dir, unasked, async () => {
        steps.push(await exists('clay.state.json.lock'));
        throw stopped;
      });

      await expect(adopting).rejects.toBe(stopped);
      expect(steps).toEqual([false]);
      expect(await exists('other.json')).toBe(false);
    });

    it('is refused, before anything is asked, where the new place holds another state', async () => {
      await new StateManager(old()).write(holding('a'));
      await new StateManager(other()).write(holding('b'));

      await expect(adoptBackend(other(), previous(), dir, unasked)).rejects.toThrow(
        '"clay.state.json" and "other.json" both hold a state, and they differ; remove the one you do not want, and run `clay init` again'
      );

      expect(await other().read()).toEqual(holding('b', 4));
      expect(await exists('.clay')).toBe(false);
      expect(await exists('clay.state.json.lock')).toBe(false);
    });

    it('is taken as it is, without asking, where the new place holds the same state', async () => {
      await new StateManager(old()).write(holding('a'));
      await adoptBackend(other(), previous(), dir, yes);
      await fs.rm(path.join(dir, '.clay'), { recursive: true });

      expect(await adoptBackend(other(), previous(), dir, unasked)).toEqual({ moved: { from: old().choice, copied: false } });

      expect(() => checkBackend(other(), dir, {})).not.toThrow();
    });

    it('is refused where the old place holds a journal and no state', async () => {
      await fs.writeFile(path.join(dir, 'clay.state.json.journal'), 'line\n', 'utf8');

      await expect(adoptBackend(other(), previous(), dir, unasked)).rejects.toThrow(
        '"clay.state.json" has a journal and no state, so there is nothing to move; remove clay.state.json.journal and run `clay init` again'
      );

      expect(await exists('.clay')).toBe(false);
      expect(await exists('clay.state.json.lock')).toBe(false);
    });
  });
});
