import { emptyState } from '@clay/contracts';
import { BackendBlock, parseModule } from '@clay/parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpStateServer } from '../../../tests/httpStateServer';
import { backendFrom, HttpBackend, newLockInfo, serializeState, StateLocked, StateManager } from '../src';
import { backendAt, Methods } from './backendAt';

const resource = { resourceType: 'local_file', name: 'a', attributes: { path: 'a.txt' } };
const blockOf = (body: string) => parseModule([{ file: 'main.clay', content: `clay {\n  backend "http" {\n${body}\n  }\n}` }])[0] as BackendBlock;
const stateWith = (serial: number) => ({ ...emptyState(), serial, resources: { 'local_file.a': resource } });

describe('a state kept on an HTTP server', () => {
  let server: HttpStateServer;

  const backendOn = (methods?: Methods) => backendAt(server.url, methods);

  const sent = () => server.received.map(({ method, path }) => `${method} ${path}`);

  beforeEach(async () => {
    server = await HttpStateServer.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('is named by its address, and chosen with every setting it runs on', () => {
    const backend = backendOn({ update: 'PUT', lock: 'POST', unlock: 'DELETE' });

    expect(backend.location).toBe(`${server.url}/state`);
    expect(backend.choice).toEqual({
      type: 'http',
      where: `${server.url}/state`,
      settings: {
        address: `${server.url}/state`,
        update_method: 'PUT',
        lock_address: `${server.url}/lock`,
        lock_method: 'POST',
        unlock_address: `${server.url}/lock`,
        unlock_method: 'DELETE',
      },
    });
  });

  it.each([
    ['404', { status: 404 }],
    ['204', { status: 204 }],
    ['an empty 200', { status: 200, body: '' }],
  ])('reads %s as no state', async (_title, answer) => {
    server.override('GET /state', answer);
    expect(await backendOn().read()).toEqual(emptyState());

    server.override('GET /state', answer);
    expect(await backendOn().exists()).toBe(false);
  });

  it('writes the state whole, with its digest, and reads it back', async () => {
    const backend = backendOn();

    await backend.write(stateWith(3));

    expect(server.state).toBe(serializeState(stateWith(3)));
    expect(server.received[0]).toMatchObject({ method: 'POST', path: '/state', id: null, digestMatches: true });
    expect(await backend.exists()).toBe(true);
    expect(await backend.read()).toEqual(stateWith(3));
  });

  it('names the lock it holds on every write, and none once released', async () => {
    const backend = backendOn();
    const info = newLockInfo('apply');

    await backend.lock(info);
    await backend.write(stateWith(1));
    await backend.unlock(info.id);
    await backend.write(stateWith(2));

    expect(server.received.filter(({ method }) => method === 'POST').map(({ id }) => id)).toEqual([info.id, null]);
  });

  it('sends the lock to the lock address and the same body back to release it', async () => {
    const backend = backendOn();
    const info = newLockInfo('apply');

    await backend.lock(info);
    expect(JSON.parse(server.lock!)).toEqual(info);

    await backend.unlock(info.id);
    expect(server.lock).toBeUndefined();
    expect(server.received.map(({ method, body, digestMatches }) => ({ method, body, digestMatches }))).toEqual([
      { method: 'LOCK', body: JSON.stringify(info), digestMatches: true },
      { method: 'UNLOCK', body: JSON.stringify(info), digestMatches: true },
    ]);
  });

  it('sends each request with the method it is given', async () => {
    for (const request of ['PUT /state', 'PUT /lock', 'DELETE /lock']) server.override(request, { status: 200 });
    const backend = backendOn({ update: 'PUT', lock: 'PUT', unlock: 'DELETE' });
    const info = newLockInfo('apply');

    await backend.lock(info);
    await backend.write(stateWith(1));
    await backend.unlock(info.id);

    expect(sent()).toEqual(['PUT /lock', 'PUT /state', 'DELETE /lock']);
  });

  it.each([409, 423])('is locked by the run the server names on %d', async (status) => {
    const holder = newLockInfo('plan');
    server.override('LOCK /lock', { status, body: JSON.stringify(holder) });

    const refusal = backendOn().lock(newLockInfo('apply'));

    await expect(refusal).rejects.toThrow(StateLocked);
    await expect(refusal).rejects.toThrow(`State is locked by plan of ${holder.who} on ${holder.host}, pid ${holder.pid}`);
    await expect(refusal).rejects.toThrow(`send UNLOCK to ${server.url}/lock with what the lock holds`);
  });

  it('is locked by a run it cannot name where the server sends no lock it can read', async () => {
    server.lock = 'not a lock';

    await expect(backendOn().lock(newLockInfo('apply'))).rejects.toThrow('State is locked by a run that left no word of who it is');
  });

  it('holds the lock for the run that took it, so another is refused', async () => {
    await backendOn().lock(newLockInfo('apply'));

    await expect(backendOn().lock(newLockInfo('plan'))).rejects.toThrow('State is locked by apply');
  });

  it.each([
    ['no lock', undefined],
    ['another lock', 'other'],
  ])('releases nothing for an id it holds %s for', async (_title, taken) => {
    const backend = backendOn();
    if (taken) await backend.lock({ ...newLockInfo('apply'), id: taken });

    await expect(backend.unlock('mine')).rejects.toThrow(`This run holds no lock mine on ${server.url}/lock, so it releases none`);
    expect(sent()).not.toContain('UNLOCK /lock');
  });

  it('keeps the lock it holds where the release fails, so it can be released again', async () => {
    const backend = backendOn();
    const info = newLockInfo('apply');
    await backend.lock(info);
    server.override('UNLOCK /lock', { status: 500 });

    await expect(backend.unlock(info.id)).rejects.toThrow(`UNLOCK ${server.url}/lock answered 500`);
    await backend.unlock(info.id);

    expect(server.lock).toBeUndefined();
  });

  it.each([
    [401, 'answered 401: the server asks for credentials, and Clay sends none'],
    [403, 'answered 403: the server refuses this request'],
    [500, 'answered 500'],
  ])('refuses a read answered %d', async (status, message) => {
    server.override('GET /state', { status });

    await expect(backendOn().read()).rejects.toThrow(`GET ${server.url}/state ${message}`);
  });

  it.each([
    ['check', (backend: HttpBackend) => backend.check(), 'GET /state', 'GET'],
    ['write', (backend: HttpBackend) => backend.write(emptyState()), 'POST /state', 'POST'],
    ['lock', (backend: HttpBackend) => backend.lock(newLockInfo('apply')), 'LOCK /lock', 'LOCK'],
  ])('refuses a %s the server fails', async (_title, act, request, method) => {
    server.override(request, { status: 500 });

    await expect(act(backendOn())).rejects.toThrow(`${method} ${server.url}${request.split(' ')[1]} answered 500`);
  });

  it.each([
    ['a read', 'GET /state', 301, (backend: HttpBackend) => backend.read()],
    ['a write', 'POST /state', 302, (backend: HttpBackend) => backend.write(emptyState())],
    ['a lock', 'LOCK /lock', 303, (backend: HttpBackend) => backend.lock(newLockInfo('apply'))],
  ])('follows no redirect of %s', async (_title, request, status, act) => {
    server.override(request, { status, location: `${server.url}/other` });
    const [method, at] = request.split(' ');

    await expect(act(backendOn())).rejects.toThrow(
      `${method} ${server.url}${at} answered ${status} to ${server.url}/other; Clay follows no redirect, so the address must name where the server answers`
    );
    expect(sent()).not.toContain('GET /other');
  });

  it('says a redirect with nowhere to go is one', async () => {
    server.override('POST /state', { status: 307 });

    await expect(backendOn().write(emptyState())).rejects.toThrow(`POST ${server.url}/state answered 307; Clay follows no redirect`);
  });

  it.each([201, 204])('takes and releases a lock the server answers %d', async (status) => {
    server.override('LOCK /lock', { status });
    server.override('UNLOCK /lock', { status });
    const backend = backendOn();
    const info = newLockInfo('apply');

    await backend.lock(info);
    await backend.write(emptyState());
    await backend.unlock(info.id);

    expect(server.received.map(({ id }) => id)).toEqual([null, info.id, null]);
  });

  it('says the server may hold a lock it answered with a body cut off', async () => {
    server.override('LOCK /lock', { status: 200, cut: true });
    const info = newLockInfo('apply');

    const refusal = backendOn().lock(info);

    await expect(refusal).rejects.toThrow(`LOCK ${server.url}/lock answered 200, but the body was cut off`);
    await expect(refusal).rejects.toThrow(`The server may hold lock ${info.id} all the same; if it does, send UNLOCK to ${server.url}/lock with what the lock holds`);
  });

  it('says the server may hold a lock it gave no answer to', async () => {
    const gone = await HttpStateServer.start();
    const { url } = gone;
    await gone.stop();
    const info = newLockInfo('apply');

    await expect(backendAt(url).lock(info)).rejects.toThrow(
      `LOCK ${url}/lock got no answer (ECONNREFUSED). The server may hold lock ${info.id} all the same; if it does, send UNLOCK to ${url}/lock with what the lock holds`
    );
  });

  it('says a read cut off is no answer, not no state', async () => {
    server.override('GET /state', { status: 200, cut: true });

    await expect(backendOn().read()).rejects.toThrow(`GET ${server.url}/state answered 200, but the body was cut off`);
  });

  it('takes no lock the server failed to take', async () => {
    const backend = backendOn();
    const info = newLockInfo('apply');
    server.override('LOCK /lock', { status: 500 });
    await expect(backend.lock(info)).rejects.toThrow('answered 500');

    await backend.write(stateWith(1));

    expect(server.received.at(-1)?.id).toBeNull();
  });

  it('refuses what is not a state, naming the address', async () => {
    server.state = 'nonsense';

    await expect(backendOn().read()).rejects.toThrow(`${server.url}/state is not valid state`);
  });

  it('says a server that does not answer gave no answer', async () => {
    const gone = await HttpStateServer.start();
    const backend = backendAt(gone.url);
    await gone.stop();

    await expect(backend.check()).rejects.toThrow(`GET ${backend.location} got no answer (ECONNREFUSED)`);
  });

  describe('as init starts it', () => {
    it('writes an empty state under the lock', async () => {
      expect(await new StateManager(backendOn()).writeIfAbsent(emptyState())).toBe(true);

      expect(sent()).toEqual(['LOCK /lock', 'GET /state', 'POST /state', 'UNLOCK /lock']);
      expect(server.received[2].id).toBe(JSON.parse(server.received[0].body).id);
      expect(JSON.parse(server.state!)).toMatchObject({ serial: 0, resources: {} });
      expect(server.lock).toBeUndefined();
    });

    it('keeps the state the server holds', async () => {
      server.state = serializeState(stateWith(4));

      expect(await new StateManager(backendOn()).writeIfAbsent(emptyState())).toBe(false);

      expect(sent()).toEqual(['LOCK /lock', 'GET /state', 'UNLOCK /lock']);
      expect(server.state).toBe(serializeState(stateWith(4)));
    });

    it('writes nothing while another run holds the lock', async () => {
      await backendOn().lock(newLockInfo('apply'));

      await expect(new StateManager(backendOn()).writeIfAbsent(emptyState())).rejects.toThrow('State is locked by apply');

      expect(server.state).toBeUndefined();
    });
  });
});

describe('the http block', () => {
  let server: HttpStateServer;

  beforeEach(async () => {
    server = await HttpStateServer.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('releases the lock at the lock address where no unlock address is given', async () => {
    const backend = backendFrom(blockOf(`address = "${server.url}/state"\nlock_address = "${server.url}/lock"`), '/workspace');
    const info = newLockInfo('apply');

    await backend.lock(info);
    await backend.unlock(info.id);

    expect(server.received.map(({ method, path }) => `${method} ${path}`)).toEqual(['LOCK /lock', 'UNLOCK /lock']);
  });

  it('takes the methods and the unlock address it names', async () => {
    server.override('PUT /state', { status: 204 });
    server.override('POST /lock', { status: 200 });
    server.override('DELETE /free', { status: 200 });
    const backend = backendFrom(
      blockOf(
        [
          `address = "${server.url}/state"`,
          'update_method = "PUT"',
          `lock_address = "${server.url}/lock"`,
          'lock_method = "POST"',
          `unlock_address = "${server.url}/free"`,
          'unlock_method = "DELETE"',
        ].join('\n')
      ),
      '/workspace'
    );
    const info = newLockInfo('apply');

    await backend.lock(info);
    await backend.write(emptyState());
    await backend.unlock(info.id);

    expect(server.received.map(({ method, path }) => `${method} ${path}`)).toEqual(['POST /lock', 'PUT /state', 'DELETE /free']);
  });
});
