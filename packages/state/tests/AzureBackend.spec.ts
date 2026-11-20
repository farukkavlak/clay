import { emptyState } from '@clay/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AzureStateServer } from '../../../tests/azureStateServer';
import { newLockInfo, serializeState, StateLocked } from '../src';
import { AzureBackend, AzureCredential, AzureLimits } from '../src/backends/AzureBackend';
import { NoAnswer } from '../src/backends/httpRequest';

const resource = { resourceType: 'local_file', name: 'a', attributes: { path: 'a.txt' } };
const stateWith = (serial: number) => ({ ...emptyState(), lineage: 'lineage', serial, resources: { 'local_file.a': resource } });

/** One try, so a test of one failing answer sees it. */
const ONCE: AzureLimits = { timeout: 5, attempts: 1, wait: 0 };
const TWICE: AzureLimits = { timeout: 5, attempts: 2, wait: 0 };

const KEY: AzureCredential = { accountKey: Buffer.from('test-key').toString('base64') };

describe('a state kept in Azure Blob storage', () => {
  let server: AzureStateServer;

  const backendOn = (limits: AzureLimits = ONCE, credential: AzureCredential = KEY, container = 'state', key = 'env/state.json') =>
    new AzureBackend({ account: server.account, container, key, endpoint: new URL(server.url), credential }, limits);
  const named = (name = 'dev', limits: AzureLimits = ONCE, key = 'env/state.json') => backendOn(limits, KEY, 'state', key).workspace(name);
  const put = (blob: string, body = serializeState(stateWith(1))) => server.put(`state/${blob}`, body);

  const at = () => `${server.url}/state/env/state.json`;
  const lockAt = () => `${at()}.lock`;
  const listAt = () => `${server.url}/state/env/clay.workspaces/`;
  const sent = () => server.received.map(({ method, path }) => `${method} ${path}`);
  const listings = () => sent().filter((request) => request === 'GET /state').length;

  beforeEach(async () => {
    server = await AzureStateServer.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('is named by its endpoint, container and key, and chosen with every setting the block gives', () => {
    const backend = backendOn();

    expect(backend.location).toBe(at());
    expect(backend.choice).toEqual({
      type: 'azure',
      where: at(),
      settings: { storage_account_name: server.account, container_name: 'state', key: 'env/state.json', endpoint: server.url },
    });
  });

  it("is named by the account's own address on Azure", () => {
    const backend = new AzureBackend({ account: 'acme', container: 'state', key: 'k', credential: KEY });

    expect(backend.location).toBe('https://acme.blob.core.windows.net/state/k');
    expect(backend.choice.settings).toEqual({ storage_account_name: 'acme', container_name: 'state', key: 'k' });
  });

  it('reads no blob, or an empty one, as no state', async () => {
    expect(await backendOn().read()).toEqual(emptyState());
    expect(await backendOn().exists()).toBe(false);

    server.put('state/env/state.json', '');
    expect(await backendOn().exists()).toBe(false);
  });

  it('writes the state whole, signed with the shared key, and reads it back', async () => {
    const backend = backendOn();

    await backend.write(stateWith(3));

    expect(server.text('state/env/state.json')).toBe(serializeState(stateWith(3)));
    expect(await backend.read()).toEqual(stateWith(3));
    expect(await backend.exists()).toBe(true);
    expect(sent()).toEqual(['PUT /state/env/state.json', 'GET /state/env/state.json', 'GET /state/env/state.json']);
    expect(server.received.map(({ signed }) => signed)).toEqual(['key', 'key', 'key']);
  });

  it('sends a SAS token with each request in place of a signature', async () => {
    const backend = backendOn(ONCE, { sasToken: 'sv=2024-11-04&sp=rcwd&sig=c2ln' });

    await backend.write(stateWith(1));

    expect(await backend.read()).toEqual(stateWith(1));
    expect(server.received.map(({ signed }) => signed)).toEqual(['sas', 'sas']);
  });

  it('writes a first state only where none is', async () => {
    const backend = backendOn();

    expect(await backend.writeIfAbsent(stateWith(1))).toBe(true);
    expect(await backend.writeIfAbsent(stateWith(2))).toBe(false);

    expect(server.text('state/env/state.json')).toBe(serializeState(stateWith(1)));
    expect(server.received.filter(({ method }) => method === 'PUT').map(({ ifNoneMatch }) => ifNoneMatch)).toEqual(['*', '*']);
  });

  it('names the place and what Azure answered, where it refuses a request', async () => {
    server.override('GET /state/env/state.json', { status: 403, code: 'AuthenticationFailed' });
    server.override('PUT /state/env/state.json', { status: 403, code: 'AuthorizationPermissionMismatch' }, { status: 403, code: 'AuthorizationPermissionMismatch' });

    await expect(backendOn().read()).rejects.toThrow(`GetBlob ${at()} answered 403 AuthenticationFailed: AuthenticationFailed from the test server`);
    await expect(backendOn().write({ ...emptyState(), lineage: 'lineage' })).rejects.toThrow(`PutBlob ${at()} answered 403 AuthorizationPermissionMismatch`);
    await expect(backendOn().writeIfAbsent({ ...emptyState(), lineage: 'lineage' })).rejects.toThrow('answered 403 AuthorizationPermissionMismatch');
  });

  it('names a container the account does not have', async () => {
    const backend = backendOn(ONCE, KEY, 'missing');

    await expect(backend.check()).rejects.toThrow(`GetBlob ${server.url}/missing/env/state.json answered 404 ContainerNotFound`);
  });

  it('says how often it tried a request that got no answer', async () => {
    server.override('GET /state/env/state.json', { lost: true }, { lost: true });

    const failed = backendOn(TWICE).read();

    await expect(failed).rejects.toThrow(NoAnswer);
    await expect(failed).rejects.toThrow(`GetBlob ${at()} got no answer (ECONNRESET) after 2 tries`);
  });

  it('reads the state where the first try got no answer', async () => {
    server.put('state/env/state.json', serializeState(stateWith(4)));
    server.override('GET /state/env/state.json', { lost: true });

    expect(await backendOn(TWICE).read()).toEqual(stateWith(4));
  });

  it('tries again after a 5xx, and names the last one after the last try', async () => {
    server.put('state/env/state.json', serializeState(stateWith(4)));
    server.override('GET /state/env/state.json', { status: 503, code: 'ServerBusy' });

    expect(await backendOn(TWICE).read()).toEqual(stateWith(4));

    server.override('GET /state/env/state.json', { status: 503, code: 'ServerBusy' }, { status: 503, code: 'ServerBusy' });
    await expect(backendOn(TWICE).read()).rejects.toThrow(`GetBlob ${at()} answered 503 ServerBusy after 2 tries`);
  });

  it('does not try again a refusal another try would not change', async () => {
    server.override('GET /state/env/state.json', { status: 403, code: 'AuthenticationFailed' });

    await expect(backendOn(TWICE).read()).rejects.toThrow(`GetBlob ${at()} answered 403 AuthenticationFailed: `);
    expect(sent()).toEqual(['GET /state/env/state.json']);
  });

  it('names an answer that is no Azure error by its status', async () => {
    server.override('GET /state/env/state.json', { raw: 502, body: '<html>proxy error' });

    const failed = backendOn().read();

    await expect(failed).rejects.toThrow(`GetBlob ${at()} answered 502 with no code: <html>proxy error`);
    await expect(failed).rejects.not.toThrow(NoAnswer);
  });

  it('gives up on a try that hangs past the time it takes', async () => {
    server.override('GET /state/env/state.json', { hang: true });

    const failed = backendOn({ timeout: 1, attempts: 1, wait: 0 }).read();

    await expect(failed).rejects.toThrow(NoAnswer);
    await expect(failed).rejects.toThrow(`GetBlob ${at()} got no answer (timed out after 1s)`);
  });

  it('times each try on its own', async () => {
    server.put('state/env/state.json', serializeState(stateWith(2)));
    server.override('GET /state/env/state.json', { hang: true });

    expect(await backendOn({ timeout: 1, attempts: 2, wait: 0 }).read()).toEqual(stateWith(2));
  });

  describe('its lock', () => {
    it('is a blob beside the state, written only where none is, and holding who took it', async () => {
      const info = newLockInfo('apply');

      await backendOn().lock(info);

      expect(JSON.parse(server.text('state/env/state.json.lock')!)).toEqual(info);
      expect(server.received).toMatchObject([{ method: 'PUT', path: '/state/env/state.json.lock', ifNoneMatch: '*' }]);
    });

    it('is refused while another run holds it, naming that run and how to free it', async () => {
      const holder = newLockInfo('plan');
      await backendOn().lock(holder);

      const taken = backendOn().lock(newLockInfo('apply'));

      await expect(taken).rejects.toThrow(StateLocked);
      await expect(taken).rejects.toThrow(`State is locked by plan of ${holder.who} on ${holder.host}`);
      await expect(taken).rejects.toThrow(`If that run is gone, run clay force-unlock ${holder.id}`);
      expect(JSON.parse(server.text('state/env/state.json.lock')!)).toEqual(holder);
    });

    it('says to delete a lock that names no run', async () => {
      server.put('state/env/state.json.lock', 'locked');

      await expect(backendOn().lock(newLockInfo('apply'))).rejects.toThrow(`State is locked by a run that left no word of who it is. If that run is gone, delete ${lockAt()}`);
    });

    it('is refused where a server answers 412 to a blob being there', async () => {
      const holder = newLockInfo('plan');
      await backendOn().lock(holder);
      server.override('PUT /state/env/state.json.lock', { status: 412, code: 'ConditionNotMet' });

      await expect(backendOn().lock(newLockInfo('apply'))).rejects.toThrow(`State is locked by plan of ${holder.who}`);
    });

    it('is tried once more where the lock it was refused for is gone when read', async () => {
      const holder = newLockInfo('plan');
      await backendOn().lock(holder);
      server.override('GET /state/env/state.json.lock', { status: 404, code: 'BlobNotFound' });
      server.received.length = 0;

      await expect(backendOn().lock(newLockInfo('apply'))).rejects.toThrow(`State is locked by plan of ${holder.who}`);
      expect(sent()).toEqual(['PUT /state/env/state.json.lock', 'GET /state/env/state.json.lock', 'PUT /state/env/state.json.lock', 'GET /state/env/state.json.lock']);
    });

    it('is taken where the answer to the first try was lost', async () => {
      const info = newLockInfo('apply');
      server.override('PUT /state/env/state.json.lock', { lost: true });

      await backendOn(TWICE).lock(info);

      expect(JSON.parse(server.text('state/env/state.json.lock')!)).toEqual(info);
      expect(sent()).toEqual(['PUT /state/env/state.json.lock', 'PUT /state/env/state.json.lock', 'GET /state/env/state.json.lock']);
    });

    it('says Azure may hold it, where no try got an answer', async () => {
      const info = newLockInfo('apply');
      server.override('PUT /state/env/state.json.lock', { lost: true });

      await expect(backendOn().lock(info)).rejects.toThrow(
        `PutBlob ${lockAt()} got no answer (ECONNRESET). Azure may hold lock ${info.id} all the same; if it does, run clay force-unlock ${info.id}`
      );
    });

    it('names what Azure answered to a request it refused', async () => {
      server.override('PUT /state/env/state.json.lock', { status: 403, code: 'AuthorizationPermissionMismatch' });

      await expect(backendOn().lock(newLockInfo('apply'))).rejects.toThrow(`PutBlob ${lockAt()} answered 403 AuthorizationPermissionMismatch`);
    });

    it('is released with a delete that names the version this run took', async () => {
      const info = newLockInfo('apply');
      const backend = backendOn();
      await backend.lock(info);
      const { etag } = server.blobs.get('state/env/state.json.lock')!;
      server.received.length = 0;

      await backend.unlock(info.id);

      expect(server.text('state/env/state.json.lock')).toBeUndefined();
      expect(server.received).toMatchObject([
        { method: 'GET', path: '/state/env/state.json.lock' },
        { method: 'DELETE', path: '/state/env/state.json.lock', ifMatch: etag },
      ]);
    });

    it('counts as released where it is gone already', async () => {
      await backendOn().unlock(newLockInfo('apply').id);

      expect(sent()).toEqual(['GET /state/env/state.json.lock']);
    });

    it('is left in place where another run holds it', async () => {
      const other = newLockInfo('plan');
      await backendOn().lock(other);

      await expect(backendOn().unlock(newLockInfo('apply').id)).rejects.toThrow(`${lockAt()} holds a lock this run did not take, so it is left in place`);
      expect(JSON.parse(server.text('state/env/state.json.lock')!)).toEqual(other);
    });

    it('is left in place where another run took it between the read and the delete', async () => {
      const info = newLockInfo('apply');
      const other = newLockInfo('plan');
      await backendOn().lock(info);
      server.override('DELETE /state/env/state.json.lock', { before: () => server.put('state/env/state.json.lock', JSON.stringify(other)) });

      await expect(backendOn().unlock(info.id)).rejects.toThrow('holds a lock this run did not take, so it is left in place');
      expect(JSON.parse(server.text('state/env/state.json.lock')!)).toEqual(other);
    });

    it.each([
      ['404, as Azure does', []],
      ['412, as Azurite does', [{ status: 412, code: 'ConditionNotMet' }]],
    ])('counts as released where a try before the last deleted it, and the next is answered %s', async (_name, next) => {
      const info = newLockInfo('apply');
      await backendOn().lock(info);
      server.override('DELETE /state/env/state.json.lock', { lost: true }, ...next);
      server.received.length = 0;

      await backendOn(TWICE).unlock(info.id);

      expect(server.text('state/env/state.json.lock')).toBeUndefined();
      expect(sent()).toEqual(['GET /state/env/state.json.lock', 'DELETE /state/env/state.json.lock', 'DELETE /state/env/state.json.lock', 'GET /state/env/state.json.lock']);
    });

    it('names what Azure answered where the delete is refused twice and the lock is still there', async () => {
      const info = newLockInfo('apply');
      await backendOn().lock(info);
      const changed = { status: 412, code: 'ConditionNotMet' };
      server.override('DELETE /state/env/state.json.lock', changed, changed);

      await expect(backendOn().unlock(info.id)).rejects.toThrow(`DeleteBlob ${lockAt()} answered 412 ConditionNotMet`);
      expect(JSON.parse(server.text('state/env/state.json.lock')!)).toEqual(info);
    });

    it('names what Azure answered to a delete it refused', async () => {
      const info = newLockInfo('apply');
      await backendOn().lock(info);
      server.override('DELETE /state/env/state.json.lock', { status: 403, code: 'AuthorizationPermissionMismatch' });

      await expect(backendOn().unlock(info.id)).rejects.toThrow(`DeleteBlob ${lockAt()} answered 403 AuthorizationPermissionMismatch`);
    });
  });

  describe('its lock forced open', () => {
    it('is released for a run that is gone', async () => {
      const gone = newLockInfo('apply');
      await backendOn().lock(gone);

      await backendOn().forceUnlock(gone.id);

      expect(server.text('state/env/state.json.lock')).toBeUndefined();
    });

    it('is left in place where it has another id', async () => {
      const other = newLockInfo('plan');
      await backendOn().lock(other);

      await expect(backendOn().forceUnlock('another')).rejects.toThrow(`${lockAt()} holds lock ${other.id}, not another, so it is left in place`);
      expect(JSON.parse(server.text('state/env/state.json.lock')!)).toEqual(other);
    });

    it('is left in place where it names no run', async () => {
      server.put('state/env/state.json.lock', 'locked');

      await expect(backendOn().forceUnlock('another')).rejects.toThrow(`${lockAt()} holds a lock that names no run, not another, so it is left in place`);
      expect(server.text('state/env/state.json.lock')).toBe('locked');
    });

    it('says no lock is held where none is', async () => {
      await expect(backendOn().forceUnlock('another')).rejects.toThrow(`No lock is held at ${lockAt()}`);
    });
  });

  describe('its workspaces', () => {
    const DEV = 'env/clay.workspaces/dev/state.json';

    it('keeps one next to the default state, with its own lock, and is chosen as the default one is', async () => {
      const workspace = named();
      const info = newLockInfo('apply');
      await workspace.prepare();

      await workspace.lock(info);
      await workspace.write(stateWith(1));

      expect(workspace.location).toBe(`${server.url}/state/${DEV}`);
      expect(workspace.choice).toEqual(backendOn().choice);
      expect(server.text(`state/${DEV}`)).toBe(serializeState(stateWith(1)));
      expect(JSON.parse(server.text(`state/${DEV}.lock`)!)).toEqual(info);
      expect(server.text('state/env/state.json')).toBeUndefined();
    });

    it('keeps one at the top of the container where the key has no folder', () => {
      expect(named('dev', ONCE, 'state.json').location).toBe(`${server.url}/state/clay.workspaces/dev/state.json`);
    });

    it('is the default state again under the name default', () => {
      expect(named('default').location).toBe(backendOn().location);
    });

    it('lists default first, then the names with a state of the default file name, in order', async () => {
      for (const blob of [
        DEV,
        'env/clay.workspaces/a/state.json',
        'env/clay.workspaces/a-1/state.json',
        'env/clay.workspaces/gone/state.json.lock',
        'env/clay.workspaces/other/b.json',
      ])
        put(blob);
      for (const blob of [
        'env/clay.workspaces/deep/er/state.json',
        'env/clay.workspaces/deep/state.json/state.json',
        'env/clay.workspaces/Bad_Name/state.json',
        'env/clay.workspaces/default/state.json',
        'clay.workspaces/top/state.json',
      ])
        put(blob);
      put('env/clay.workspaces/empty/state.json', '');
      put('env/clay.workspaces/folder', '');

      expect(await backendOn().listWorkspaces()).toEqual(['default', 'a', 'a-1', 'dev']);
    });

    it('lists default alone where no workspace is', async () => {
      expect(await backendOn().listWorkspaces()).toEqual(['default']);
    });

    it('reads every page of the listing', async () => {
      server.pageSize = 2;
      for (const name of ['a', 'b', 'c', 'd', 'e']) put(`env/clay.workspaces/${name}/state.json`);

      expect(await backendOn().listWorkspaces()).toEqual(['default', 'a', 'b', 'c', 'd', 'e']);
      expect(listings()).toBe(3);
    });

    it('tries a listing again after a passing failure', async () => {
      put(DEV);
      server.override('GET /state', { status: 503, code: 'ServerBusy' });

      expect(await backendOn(TWICE).listWorkspaces()).toEqual(['default', 'dev']);
    });

    it('names the permission a refused listing needs', async () => {
      server.override('GET /state', { status: 403, code: 'AuthorizationPermissionMismatch' });

      await expect(backendOn().listWorkspaces()).rejects.toThrow(
        `Azure refused to list ${listAt()}; finding workspaces needs permission to list the blobs of container "state": "l" in a SAS token, or a data role such as Storage Blob Data Reader`
      );
    });

    it('says what Azure answered to a listing it failed for another reason', async () => {
      server.override('GET /state', { status: 404, code: 'ContainerNotFound' });

      await expect(backendOn().listWorkspaces()).rejects.toThrow(`ListBlobs ${listAt()} answered 404 ContainerNotFound`);
    });

    it('exists only with its state', async () => {
      expect(await named().exists()).toBe(false);
      put(DEV);

      expect(await named().exists()).toBe(true);
    });

    it('is not read as empty once its state is gone', async () => {
      await expect(named().read()).rejects.toThrow('Workspace "dev" does not exist');
    });

    it('refuses a lock on a workspace deleted meanwhile, and leaves no lock', async () => {
      await expect(named().lock(newLockInfo('apply'))).rejects.toThrow('Workspace "dev" does not exist');

      expect(server.text(`state/${DEV}.lock`)).toBeUndefined();
    });

    it('gives the lock back where its state cannot be read, and says why', async () => {
      put(DEV);
      server.override(`GET /state/${DEV}`, { status: 403, code: 'AuthorizationFailure' });

      await expect(named().lock(newLockInfo('apply'))).rejects.toThrow(`GetBlob ${server.url}/state/${DEV} answered 403 AuthorizationFailure`);
      expect(server.text(`state/${DEV}.lock`)).toBeUndefined();
    });

    it('is locked where its state exists', async () => {
      put(DEV);
      const info = newLockInfo('apply');

      await named().lock(info);

      expect(JSON.parse(server.text(`state/${DEV}.lock`)!)).toEqual(info);
    });

    it('removes only its state', async () => {
      put(DEV);
      put(`${DEV}.lock`, 'held');
      put('env/state.json');

      await named().remove();
      await named().prune();

      expect(server.text(`state/${DEV}`)).toBeUndefined();
      expect(server.text(`state/${DEV}.lock`)).toBe('held');
      expect(server.text('state/env/state.json')).toBeDefined();
    });

    it('counts a state already gone as removed', async () => {
      await expect(named().remove()).resolves.toBeUndefined();
    });

    it('never removes the default state', async () => {
      put('env/state.json');

      await expect(named('default').remove()).rejects.toThrow('The state of the default workspace is not removed');
      expect(server.text('state/env/state.json')).toBeDefined();
    });

    it('says what Azure answered to a removal it refused', async () => {
      server.override(`DELETE /state/${DEV}`, { status: 403, code: 'AuthorizationFailure' });

      await expect(named().remove()).rejects.toThrow(`DeleteBlob ${server.url}/state/${DEV} answered 403 AuthorizationFailure`);
    });

    it('takes the longest key whose lock fits', async () => {
      await expect(named('dev', ONCE, 'k'.repeat(999)).prepare()).resolves.toBeUndefined();
    });

    it('refuses a workspace whose lock would not fit', async () => {
      await expect(named('dev', ONCE, 'k'.repeat(1000)).prepare()).rejects.toThrow(
        'The lock of workspace "dev" would have a name of 1025 characters, and Azure takes 1024 at most; use a shorter key in the backend block'
      );
    });

    it('counts a first write as done where the answer was lost and the try sent again finds it', async () => {
      server.override(`PUT /state/${DEV}`, { lost: true });

      expect(await named('dev', TWICE).writeIfAbsent(stateWith(1))).toBe(true);
      expect(server.text(`state/${DEV}`)).toBe(serializeState(stateWith(1)));
    });

    it('does not write over another state', async () => {
      put(DEV, serializeState(stateWith(2)));

      expect(await named().writeIfAbsent(stateWith(1))).toBe(false);
      expect(server.text(`state/${DEV}`)).toBe(serializeState(stateWith(2)));
    });

    it('writes over an empty blob, which is no state', async () => {
      put(DEV, '');

      expect(await named().writeIfAbsent(stateWith(1))).toBe(true);
      expect(server.text(`state/${DEV}`)).toBe(serializeState(stateWith(1)));
    });
  });
});
