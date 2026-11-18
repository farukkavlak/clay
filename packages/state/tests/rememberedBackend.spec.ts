import { emptyState, isWritten, State } from '@clay/contracts';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AzureStateServer } from '../../../tests/azureStateServer';
import { HttpStateServer } from '../../../tests/httpStateServer';
import { S3StateServer } from '../../../tests/s3StateServer';
import {
  adoptBackend,
  Approve,
  checkBackend,
  LocalBackend,
  LockNotReleased,
  newLockInfo,
  rememberedBackend,
  serializeState,
  StateBackend,
  StateLocked,
  StateManager,
} from '../src';
import { AzureBackend } from '../src/backends/AzureBackend';
import { S3Backend } from '../src/backends/S3Backend';
import { backendAt, ONCE } from './backendAt';

/** For a call that must not ask. */
const unasked: Approve = () => {
  throw new Error('asked');
};
const yes: Approve = async () => true;

const holding = (name: string, serial = 3): State => ({ ...emptyState(), lineage: 'lineage', serial, resources: { [`rt.${name}`]: { resourceType: 'rt', name, attributes: {} } } });

/** Writes `state` to `backend` as a run does, under a lock released after it. */
async function written(backend: StateBackend, state: State): Promise<void> {
  const manager = new StateManager(backend);
  await manager.lock('apply');
  await manager.write(state);
  await manager.unlock();
}

describe('the backend init remembers', () => {
  let dir: string;

  const recordPath = () => path.join(dir, '.clay', 'backend.json');
  const write = (content: unknown) => fs.writeFile(recordPath(), JSON.stringify(content), 'utf8');
  const recorded = async (): Promise<unknown> => JSON.parse(await fs.readFile(recordPath(), 'utf8'));
  const previous = () => {
    const backend = rememberedBackend(dir, {});
    return { backend, manage: (locked: StateBackend) => new StateManager(locked) };
  };
  const old = () => new LocalBackend(dir);
  const other = () => new LocalBackend(dir, 'other.json');
  const named = async (name: string) => {
    const backend = old().workspace(name);
    await backend.prepare();
    await written(backend, holding(name));
  };
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

  it('moves nothing where the state is gone by the time it is read', async () => {
    await written(old(), holding('a'));
    await adoptBackend(old(), previous(), dir, unasked);
    const read = vi.spyOn(LocalBackend.prototype, 'read').mockImplementationOnce(async () => {
      await fs.rm(path.join(dir, 'clay.state.json'));
      return emptyState();
    });

    try {
      await adoptBackend(other(), previous(), dir, unasked);
    } finally {
      read.mockRestore();
    }

    expect(await exists('other.json')).toBe(false);
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

      expect(await adoptBackend(new LocalBackend(dir), previous(), dir, yes)).toMatchObject({
        moved: { workspaces: [{ name: 'default', copied: true }], from: { where: `${server.url}/state` } },
      });

      expect(await new LocalBackend(dir).read()).toEqual(holding('a'));
      expect(server.state).toBe(serializeState(holding('a')));
      expect(server.lock).toBeUndefined();
      expect(() => checkBackend(new LocalBackend(dir), dir, {})).not.toThrow();
    });

    it('takes a file state to the server', async () => {
      await written(new LocalBackend(dir), holding('a', 2));

      await adoptBackend(backendOn('state'), previous(), dir, yes);

      expect(JSON.parse(server.state!)).toEqual(holding('a'));
      expect(() => checkBackend(backendOn('state'), dir, {})).not.toThrow();
    });

    it('says the old lock is left once the state has moved, and keeps the record', async () => {
      server.state = serializeState(holding('a'));
      await record({});
      server.override('UNLOCK /lock', { status: 500 });

      const { locksLeft } = await adoptBackend(new LocalBackend(dir), previous(), dir, yes);

      expect(locksLeft).toEqual([expect.any(LockNotReleased)]);
      expect(locksLeft?.[0].message).toContain(`UNLOCK ${server.url}/lock`);
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

      expect(await adoptBackend(backend, previous(), dir, yes)).toEqual({ moved: { from: backendOn('state').choice, workspaces: [{ name: 'default', copied: true }] } });

      expect(JSON.parse(server.other!)).toEqual(holding('a'));
      expect(server.received.filter(({ method }) => method === 'LOCK')).toHaveLength(1);
    });

    it('keeps the refusal beside a lock it could not release', async () => {
      server.state = serializeState(holding('a'));
      await record({});
      await written(new LocalBackend(dir), holding('b'));
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

    it('is refused as the place of named workspaces, before anything is locked', async () => {
      await named('dev');

      await expect(adoptBackend(backendOn('state'), previous(), dir, unasked)).rejects.toThrow(
        'Workspaces other than the default one are kept with "clay.state.json" (local): "dev"; backend "http" keeps one state, so delete them with `clay workspace delete` or keep this backend'
      );

      expect(server.received).toEqual([]);
      expect(await exists(path.join('.clay', 'backend.json'))).toBe(false);
      expect(await exists(path.join('clay.workspaces', 'dev', 'clay.state.json.lock'))).toBe(false);
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

  describe('in S3', () => {
    let server: S3StateServer;

    const backendOn = (key: string, endpoint = server.url, pathStyle = true) =>
      new S3Backend({ bucket: 'bucket', key, region: 'eu-west-1', regionInBlock: true, endpoint: new URL(endpoint), pathStyle }, { timeout: 5, attempts: 1 });
    const record = (settings: Record<string, unknown>) => write({ type: 's3', settings: { ...backendOn('state').choice.settings, ...settings } });

    beforeEach(async () => {
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-key');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret');
      server = await S3StateServer.start();
      await fs.mkdir(path.join(dir, '.clay'));
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await server.stop();
    });

    it('is remembered by its bucket, its key and its endpoint', async () => {
      await adoptBackend(backendOn('state'), previous(), dir, unasked);

      expect(() => checkBackend(backendOn('state'), dir, {})).not.toThrow();
      expect(() => checkBackend(backendOn('state', 'http://127.0.0.1:1'), dir, {})).toThrow(
        `keeps its state in "s3://bucket/state at ${server.url}/" (s3), and the configuration names "s3://bucket/state at http://127.0.0.1:1/" (s3)`
      );
    });

    it('is built again with the path style the record holds', async () => {
      await adoptBackend(backendOn('state'), previous(), dir, unasked);

      expect(() => checkBackend(backendOn('state', server.url, false), dir, {})).toThrow(
        'use_path_style of backend "s3" is false in the configuration, and true where `clay init` took it; run `clay init`'
      );
    });

    it('is refused where the record holds a path style that is no boolean', async () => {
      await record({ use_path_style: 'true' });

      expect(() => checkBackend(new LocalBackend(dir), dir, {})).toThrow('is not what `clay init` writes');
    });

    it('takes a file state into the bucket', async () => {
      await fs.writeFile(path.join(dir, 'clay.state.json'), serializeState(holding('a')), 'utf8');

      expect(await adoptBackend(backendOn('state'), previous(), dir, yes)).toMatchObject({ moved: { workspaces: [{ name: 'default', copied: true }] } });

      expect(server.text('bucket/state')).toBe(serializeState(holding('a')));
      expect(server.text('bucket/state.lock')).toBeUndefined();
    });

    it('names the way out where the old endpoint gives no answer', async () => {
      await record({ endpoint: 'http://127.0.0.1:1/' });

      await expect(adoptBackend(new LocalBackend(dir), previous(), dir, unasked)).rejects.toThrow(
        `GetObject s3://bucket/state at http://127.0.0.1:1/ got no answer (ECONNREFUSED) after 3 tries. Whether a state is left there is not known; if that server is gone for good, remove ${recordPath()} and run \`clay init\` again`
      );
    });
  });

  describe('in Azure', () => {
    let server: AzureStateServer;
    const env = { AZURE_STORAGE_KEY: Buffer.from('test-key').toString('base64') };

    const backendOn = (key: string, endpoint = server.url) =>
      new AzureBackend(
        { account: server.account, container: 'state', key, endpoint: new URL(endpoint), credential: { accountKey: env.AZURE_STORAGE_KEY } },
        { timeout: 5, attempts: 1, wait: 0 }
      );
    const record = (settings: Record<string, unknown>) => write({ type: 'azure', settings: { ...backendOn('state').choice.settings, ...settings } });
    const previousIn = () => {
      const backend = rememberedBackend(dir, env);
      return { backend, manage: (locked: StateBackend) => new StateManager(locked) };
    };

    beforeEach(async () => {
      server = await AzureStateServer.start();
      await fs.mkdir(path.join(dir, '.clay'));
    });

    afterEach(async () => {
      await server.stop();
    });

    it('is remembered by its account, its container, its key and its endpoint', async () => {
      await adoptBackend(backendOn('state'), previousIn(), dir, unasked);

      expect(await recorded()).toEqual({ type: 'azure', settings: { storage_account_name: server.account, container_name: 'state', key: 'state', endpoint: server.url } });
      expect(() => checkBackend(backendOn('state'), dir, env)).not.toThrow();
      expect(() => checkBackend(backendOn('other'), dir, env)).toThrow(
        `keeps its state in "${server.url}/state/state" (azure), and the configuration names "${server.url}/state/other" (azure)`
      );
    });

    it('takes a file state into the container', async () => {
      await fs.writeFile(path.join(dir, 'clay.state.json'), serializeState(holding('a')), 'utf8');

      expect(await adoptBackend(backendOn('state'), previousIn(), dir, yes)).toMatchObject({ moved: { workspaces: [{ name: 'default', copied: true }] } });

      expect(server.text('state/state')).toBe(serializeState(holding('a')));
      expect(server.text('state/state.lock')).toBeUndefined();
    });

    it('names the way out where the old endpoint gives no answer', async () => {
      await record({ endpoint: `http://127.0.0.1:1/${server.account}` });

      await expect(adoptBackend(new LocalBackend(dir), previousIn(), dir, unasked)).rejects.toThrow(
        `GetBlob http://127.0.0.1:1/${server.account}/state/state got no answer (ECONNREFUSED) after 3 tries. Whether a state is left there is not known; if that server is gone for good, remove ${recordPath()} and run \`clay init\` again`
      );
    });
  });

  describe('a state at the old place', () => {
    it('is moved once asked, with what its journal holds, and the old one is kept', async () => {
      const manager = new StateManager(old());
      const state = holding('a');
      await manager.lock('apply');
      await manager.write(state);
      state.resources['rt.b'] = { resourceType: 'rt', name: 'b', attributes: {} };
      await manager.record(state, 'rt.b');
      await manager.unlock();
      const approve = vi.fn(yes);

      expect(await adoptBackend(other(), previous(), dir, approve)).toEqual({ moved: { from: old().choice, workspaces: [{ name: 'default', copied: true }] } });

      expect(approve).toHaveBeenCalledWith('Move the state in "clay.state.json" (local) to "other.json" (local)?');
      expect(await other().read()).toEqual(state);
      expect(await old().read()).toEqual(state);
      expect(await exists('clay.state.json.journal')).toBe(true);
      expect(() => checkBackend(other(), dir, {})).not.toThrow();
    });

    it('is asked about under the lock of the old place, which is then released', async () => {
      await written(old(), holding('a'));
      let lockedWhileAsked = false;

      await adoptBackend(other(), previous(), dir, async () => {
        lockedWhileAsked = await exists('clay.state.json.lock');
        return true;
      });

      expect(lockedWhileAsked).toBe(true);
      expect(await exists('clay.state.json.lock')).toBe(false);
    });

    it('is left where it is, with nothing written, when the answer is no', async () => {
      await written(old(), holding('a'));

      await expect(adoptBackend(other(), previous(), dir, async () => false)).rejects.toThrow('The state was not moved, and nothing changed');

      expect(await exists('other.json')).toBe(false);
      expect(await exists('.clay')).toBe(false);
      expect(await exists('clay.state.json.lock')).toBe(false);
    });

    it('is not moved while another run holds the old lock', async () => {
      await written(old(), holding('a'));
      await old().lock(newLockInfo('apply'));

      await expect(adoptBackend(other(), previous(), dir, unasked)).rejects.toThrow(StateLocked);

      expect(await exists('other.json')).toBe(false);
      expect(await exists('.clay')).toBe(false);
    });

    it('has its old lock taken as a step the caller can stop', async () => {
      await written(old(), holding('a'));
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
      await written(old(), holding('a'));
      await written(other(), holding('b'));

      await expect(adoptBackend(other(), previous(), dir, unasked)).rejects.toThrow(
        '"clay.state.json" and "other.json" both hold a state, and they differ; remove the one you do not want, and run `clay init` again'
      );

      expect(await other().read()).toEqual(holding('b', 4));
      expect(await exists('.clay')).toBe(false);
      expect(await exists('clay.state.json.lock')).toBe(false);
    });

    it('is taken as it is, without asking, where the new place holds the same state', async () => {
      await written(old(), holding('a'));
      await adoptBackend(other(), previous(), dir, yes);
      await fs.rm(path.join(dir, '.clay'), { recursive: true });

      expect(await adoptBackend(other(), previous(), dir, unasked)).toEqual({ moved: { from: old().choice, workspaces: [{ name: 'default', copied: false }] } });

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

  describe('named workspaces at the old place', () => {
    const elsewhere = () => new LocalBackend(dir, path.join('there', 'state.json'));
    const devLock = path.join('clay.workspaces', 'dev', 'clay.state.json.lock');
    const newDevLock = path.join('there', 'clay.workspaces', 'dev', 'state.json.lock');
    /** A previous whose manager of the state at `where` fails to release its lock. */
    const unlockFailsAt = (where: string) => ({
      backend: rememberedBackend(dir, {}),
      manage: (locked: StateBackend) =>
        new StateManager(
          locked.location === path.join(dir, where)
            ? new Proxy(locked, {
                get: (target, key, receiver) =>
                  key === 'unlock'
                    ? async () => {
                        throw new Error('unlock failed');
                      }
                    : Reflect.get(target, key, receiver),
              })
            : locked
        ),
    });

    beforeEach(async () => {
      await fs.mkdir(path.join(dir, 'there'));
    });

    it('are moved with the default one after one question, under every old lock, and the old states are kept', async () => {
      await written(old(), holding('a'));
      await named('dev');
      await named('pr-12');
      const asked: string[] = [];
      const approve: Approve = async (question) => {
        asked.push(question, String(await exists(devLock)));
        return true;
      };

      expect(await adoptBackend(elsewhere(), previous(), dir, approve)).toEqual({
        moved: {
          from: old().choice,
          workspaces: [
            { name: 'dev', copied: true },
            { name: 'pr-12', copied: true },
            { name: 'default', copied: true },
          ],
        },
      });

      expect(asked).toEqual([`Move the states of workspaces "dev", "pr-12", "default" in "clay.state.json" (local) to "${path.join('there', 'state.json')}" (local)?`, 'true']);
      expect(await elsewhere().workspace('dev').read()).toEqual(await old().workspace('dev').read());
      expect(await elsewhere().workspace('pr-12').read()).toEqual(await old().workspace('pr-12').read());
      expect(await elsewhere().read()).toEqual(await old().read());
      expect(await elsewhere().listWorkspaces()).toEqual(['default', 'dev', 'pr-12']);
      expect(await old().listWorkspaces()).toEqual(['default', 'dev', 'pr-12']);
      expect(await exists(devLock)).toBe(false);
      expect(await exists(path.join('there', 'clay.workspaces', 'dev', 'state.json.lock'))).toBe(false);
      expect(() => checkBackend(elsewhere(), dir, {})).not.toThrow();
    });

    it('are moved where the default workspace has no state', async () => {
      await named('dev');
      const approve = vi.fn(yes);

      expect(await adoptBackend(elsewhere(), previous(), dir, approve)).toEqual({ moved: { from: old().choice, workspaces: [{ name: 'dev', copied: true }] } });

      expect(approve).toHaveBeenCalledWith(`Move the state of workspace "dev" in "clay.state.json" (local) to "${path.join('there', 'state.json')}" (local)?`);
      expect(await elsewhere().exists()).toBe(false);
      expect(() => checkBackend(elsewhere(), dir, {})).not.toThrow();
    });

    it('go on where a stopped init left them, and only the rest is asked about', async () => {
      await written(old(), holding('a'));
      await named('dev');
      await named('pr-12');
      const copy = elsewhere().workspace('dev');
      await copy.prepare();
      const state = await old().workspace('dev').read();
      assert(isWritten(state));
      await copy.write(state);
      const approve = vi.fn(yes);

      const { moved } = await adoptBackend(elsewhere(), previous(), dir, approve);

      expect(moved?.workspaces).toEqual([
        { name: 'dev', copied: false },
        { name: 'pr-12', copied: true },
        { name: 'default', copied: true },
      ]);

      expect(approve).toHaveBeenCalledWith(expect.stringMatching(/^Move the states of workspaces "pr-12", "default" in /));
    });

    it('are refused, before anything is asked or written, where the new place holds another state of one', async () => {
      await written(old(), holding('a'));
      await named('dev');
      await named('pr-12');
      const taken = elsewhere().workspace('pr-12');
      await taken.prepare();
      await written(taken, holding('b'));

      await expect(adoptBackend(elsewhere(), previous(), dir, unasked)).rejects.toThrow(
        `"clay.state.json" and "${path.join('there', 'state.json')}" both hold a state of workspace "pr-12", and they differ; remove the one you do not want, and run \`clay init\` again`
      );

      expect(await elsewhere().listWorkspaces()).toEqual(['default', 'pr-12']);
      expect(await exists(path.join('there', 'clay.workspaces', 'dev'))).toBe(false);
      expect(await exists('.clay')).toBe(false);
      expect(await exists(devLock)).toBe(false);
      expect(await exists('clay.state.json.lock')).toBe(false);
    });

    it('are left where they are, and the folders made for them cleared, when the answer is no', async () => {
      await named('dev');
      await named('pr-12');

      await expect(adoptBackend(elsewhere(), previous(), dir, async () => false)).rejects.toThrow('The states were not moved, and nothing changed');

      expect(await exists(path.join('there', 'clay.workspaces'))).toBe(false);
      expect(await exists('.clay')).toBe(false);
      expect(await exists(devLock)).toBe(false);
    });

    it('are not moved while another run holds the lock of one, which is left to it', async () => {
      await written(old(), holding('a'));
      await named('dev');
      await old().workspace('dev').lock(newLockInfo('apply'));

      await expect(adoptBackend(elsewhere(), previous(), dir, unasked)).rejects.toThrow(StateLocked);

      expect(await exists(devLock)).toBe(true);
      expect(await exists(path.join('there', 'clay.workspaces'))).toBe(false);
      expect(await exists('.clay')).toBe(false);
    });

    it('have their locks taken as steps the caller can stop, and the ones taken released', async () => {
      await named('dev');
      const stopped = new Error('stopped at the second lock');
      let steps = 0;

      const adopting = adoptBackend(elsewhere(), previous(), dir, unasked, async (step) => {
        steps += 1;
        if (steps === 2) throw stopped;
        return step();
      });

      await expect(adopting).rejects.toBe(stopped);
      expect(await exists(newDevLock)).toBe(false);
      expect(await exists(path.join('there', 'clay.workspaces'))).toBe(false);
      expect(await exists('.clay')).toBe(false);
    });

    it('have every other lock released where one is not, which is named', async () => {
      await written(old(), holding('a'));
      await named('dev');

      const { locksLeft } = await adoptBackend(elsewhere(), unlockFailsAt(path.join('there', 'clay.workspaces', 'dev', 'state.json')), dir, yes);

      expect(locksLeft).toEqual([expect.any(LockNotReleased)]);
      expect(locksLeft?.[0].message).toBe('unlock failed');
      expect(await exists(newDevLock)).toBe(true);
      expect(await exists(devLock)).toBe(false);
      expect(await exists('clay.state.json.lock')).toBe(false);
      expect(() => checkBackend(elsewhere(), dir, {})).not.toThrow();
    });

    it('keep the refusal beside a lock not released, and release the others', async () => {
      await named('dev');

      const refused = adoptBackend(elsewhere(), unlockFailsAt(path.join('there', 'clay.workspaces', 'dev', 'state.json')), dir, async () => false);

      await expect(refused).rejects.toMatchObject({
        message: 'The run failed, and a lock it took or a folder it made is left',
        errors: [{ message: 'The state was not moved, and nothing changed' }, { message: 'unlock failed' }],
      });
      expect(await exists(devLock)).toBe(false);
      expect(await exists('.clay')).toBe(false);
    });

    it('keep the refusal beside a folder made for one that could not be cleared', async () => {
      await named('dev');
      const pruneFails = new LocalBackend(dir, path.join('there', 'state.json'));
      const workspace = pruneFails.workspace.bind(pruneFails);
      pruneFails.workspace = (name) =>
        Object.assign(workspace(name), {
          prune: async () => {
            throw new Error('prune failed');
          },
        });

      await expect(adoptBackend(pruneFails, previous(), dir, async () => false)).rejects.toMatchObject({
        errors: [{ message: 'The state was not moved, and nothing changed' }, { message: 'prune failed' }],
      });
      expect(await exists(newDevLock)).toBe(false);
      expect(await exists(devLock)).toBe(false);
    });
  });
});
