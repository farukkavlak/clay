import { emptyState } from '@clay/contracts';
import { BackendBlock, parseModule } from '@clay/parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpStateServer } from '../../../tests/httpStateServer';
import { backendFrom, HttpBackend, newLockInfo, Retry, serializeState, StateBackend, StateLocked, StateManager } from '../src';
import { backendAt, Methods, ONCE } from './backendAt';

const resource = { resourceType: 'local_file', name: 'a', attributes: { path: 'a.txt' } };
const blockOf = (body: string) => parseModule([{ file: 'main.clay', content: `clay {\n  backend "http" {\n${body}\n  }\n}` }])[0] as BackendBlock;
const basic = (pair: string) => `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;

/** A read, a write, a lock and its release: every request the backend sends. */
async function runAll(backend: StateBackend): Promise<void> {
  const info = newLockInfo('apply');
  await backend.lock(info);
  await backend.read();
  await backend.write(emptyState());
  await backend.unlock(info.id);
}

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
        retry_max: 0,
        retry_wait_min: 0,
        retry_wait_max: 0,
        timeout: 5,
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
    [401, 'answered 401: the server asks for credentials; give them in CLAY_HTTP_USERNAME and CLAY_HTTP_PASSWORD'],
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

describe('a request the HTTP server fails', () => {
  let server: HttpStateServer;
  let waits: number[];

  const TWICE: Retry = { max: 2, waitMin: 1, waitMax: 30, timeout: 5 };
  const backendWith = (retry: Retry) =>
    backendAt(server.url, {}, 'state', retry, async (ms) => {
      waits.push(ms);
    });
  const sent = () => server.received.map(({ method, path }) => `${method} ${path}`);

  beforeEach(async () => {
    server = await HttpStateServer.start();
    waits = [];
  });

  afterEach(async () => {
    await server.stop();
  });

  it('is tried again after a 5xx, waiting twice as long each time', async () => {
    server.state = serializeState(stateWith(2));
    server.override('GET /state', { status: 503 }, { status: 502 }, { status: 500 });

    expect(await backendWith({ ...TWICE, max: 3 }).read()).toEqual(stateWith(2));

    expect(waits).toEqual([1000, 2000, 4000]);
    expect(sent()).toEqual(['GET /state', 'GET /state', 'GET /state', 'GET /state']);
  });

  it('is given up after its tries, naming how many', async () => {
    server.override('GET /state', { status: 500 }, { status: 500 }, { status: 500 });

    await expect(backendWith(TWICE).read()).rejects.toThrow(new Error(`GET ${server.url}/state answered 500 after 3 tries`));
    expect(waits).toEqual([1000, 2000]);
  });

  it('waits no longer than the longest wait', async () => {
    server.override('GET /state', { status: 500 }, { status: 500 }, { status: 500 });

    await backendWith({ ...TWICE, max: 3, waitMin: 10, waitMax: 15 }).read();

    expect(waits).toEqual([10_000, 15_000, 15_000]);
  });

  it('is tried again after a 429', async () => {
    server.override('GET /state', { status: 429 });

    await backendWith(TWICE).read();

    expect(waits).toEqual([1000]);
  });

  it.each([400, 403, 501])('is not tried again after a %d, which another try answers the same', async (status) => {
    server.override('GET /state', { status });

    await expect(backendWith(TWICE).read()).rejects.toThrow(`GET ${server.url}/state answered ${status}`);
    expect(sent()).toEqual(['GET /state']);
  });

  it.each([
    ['in seconds', '7', 7000],
    ['as a date gone by', 'Thu, 01 Jan 1970 00:00:00 GMT', 0],
  ])('waits as long as Retry-After asks %s', async (_title, retryAfter, wait) => {
    server.override('GET /state', { status: 503, retryAfter });

    await backendWith(TWICE).read();

    expect(waits).toEqual([wait]);
  });

  it.each(['1.5', '-1', 'soon'])('waits as it would without a Retry-After of %s, which is neither seconds nor a date', async (retryAfter) => {
    server.override('GET /state', { status: 503, retryAfter });

    await backendWith(TWICE).read();

    expect(waits).toEqual([1000]);
  });

  it('is given up where Retry-After asks for longer than the longest wait', async () => {
    server.override('GET /state', { status: 503, retryAfter: '120' });

    await expect(backendWith(TWICE).read()).rejects.toThrow(new Error(`GET ${server.url}/state answered 503; it asks to be tried again after 120`));
    expect(sent()).toEqual(['GET /state']);
  });

  it('is tried again where it got no answer', async () => {
    server.override('GET /state', { lost: true });

    expect(await backendWith(TWICE).read()).toEqual(emptyState());
    expect(waits).toEqual([1000]);
  });

  it('says how many tries got no answer', async () => {
    const gone = await HttpStateServer.start();
    const { url } = gone;
    await gone.stop();

    await expect(backendAt(url, {}, 'state', TWICE, async () => {}).read()).rejects.toMatchObject({ message: `GET ${url}/state got no answer (ECONNREFUSED) after 3 tries` });
  });

  it('gives up on a try the server does not answer in time, and tries again', async () => {
    server.override('GET /state', { hang: true }, { hang: true });

    await expect(backendWith({ ...ONCE, timeout: 0.2 }).read()).rejects.toMatchObject({ message: `GET ${server.url}/state got no answer (timed out after 0.2s)` });
    expect(await backendWith({ ...ONCE, max: 1, timeout: 0.2 }).read()).toEqual(emptyState());
  });

  it('gives up on a body that stops coming', async () => {
    server.override('GET /state', { status: 200, stall: true });

    await expect(backendWith({ ...ONCE, timeout: 0.2 }).read()).rejects.toMatchObject({
      message: `GET ${server.url}/state answered 200, but the body was cut off (timed out after 0.2s)`,
    });
  });

  it('writes the same state again where the answer to a write was lost', async () => {
    server.override('POST /state', { lost: true });

    await backendWith(TWICE).write(stateWith(1));

    expect(server.state).toBe(serializeState(stateWith(1)));
    expect(server.received.map(({ body }) => body)).toEqual([serializeState(stateWith(1)), serializeState(stateWith(1))]);
  });

  it('holds the lock a try took whose answer was lost, as the next try finds it under its own id', async () => {
    server.override('LOCK /lock', { lost: true });
    const backend = backendWith(TWICE);
    const info = newLockInfo('apply');

    await backend.lock(info);
    await backend.write(stateWith(1));
    await backend.unlock(info.id);

    expect(sent()).toEqual(['LOCK /lock', 'LOCK /lock', 'POST /state', 'UNLOCK /lock']);
    expect(server.received[2].id).toBe(info.id);
    expect(server.lock).toBeUndefined();
  });

  it('says the server may hold the lock where a lost try came before a failed one', async () => {
    server.override('LOCK /lock', { lost: true }, { status: 503 });
    const info = newLockInfo('apply');

    await expect(backendWith({ ...TWICE, max: 1 }).lock(info)).rejects.toThrow(
      new Error(
        `LOCK ${server.url}/lock answered 503 after 2 tries. The server may hold lock ${info.id} all the same; if it does, send UNLOCK to ${server.url}/lock with what the lock holds`
      )
    );
    expect(JSON.parse(server.lock!)).toEqual(info);
  });

  it('is locked by another run that took the lock between two tries', async () => {
    const holder = newLockInfo('plan');
    server.override('LOCK /lock', { status: 503 }, { status: 423, body: JSON.stringify(holder) });

    await expect(backendWith(TWICE).lock(newLockInfo('apply'))).rejects.toThrow(`State is locked by plan of ${holder.who}`);
  });

  it('says the server may hold the lock where every try went unanswered', async () => {
    server.override('LOCK /lock', { lost: true }, { hang: true });
    const info = newLockInfo('apply');

    await expect(backendWith({ ...TWICE, max: 1, timeout: 0.2 }).lock(info)).rejects.toThrow(
      `LOCK ${server.url}/lock got no answer (timed out after 0.2s) after 2 tries. The server may hold lock ${info.id} all the same`
    );
  });

  it('says nothing of a try before where a release was tried once', async () => {
    const backend = backendWith(ONCE);
    const info = newLockInfo('apply');
    await backend.lock(info);
    server.override('UNLOCK /lock', { status: 409 });

    await expect(backend.unlock(info.id)).rejects.toThrow(new Error(`UNLOCK ${server.url}/lock answered 409`));
  });

  it('says a try before a refused release may have released the lock', async () => {
    const backend = backendWith({ ...TWICE, max: 1 });
    const info = newLockInfo('apply');
    await backend.lock(info);
    server.override('UNLOCK /lock', { lost: true });

    await expect(backend.unlock(info.id)).rejects.toThrow(
      new Error(`UNLOCK ${server.url}/lock answered 409 after 2 tries. A try before it may have released lock ${info.id} all the same`)
    );
    expect(server.lock).toBeUndefined();
  });
});

describe('the http block', () => {
  let server: HttpStateServer;

  const backendWith = (env: Record<string, string>) => backendFrom(blockOf(`address = "${server.url}/state"\nlock_address = "${server.url}/lock"`), '/workspace', env);

  beforeEach(async () => {
    server = await HttpStateServer.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('releases the lock at the lock address where no unlock address is given', async () => {
    const backend = backendFrom(blockOf(`address = "${server.url}/state"\nlock_address = "${server.url}/lock"`), '/workspace', {});
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
      '/workspace',
      {}
    );
    const info = newLockInfo('apply');

    await backend.lock(info);
    await backend.write(emptyState());
    await backend.unlock(info.id);

    expect(server.received.map(({ method, path }) => `${method} ${path}`)).toEqual(['POST /lock', 'PUT /state', 'DELETE /free']);
  });

  describe('with credentials in the environment', () => {
    it('sends them with every request, to a server that asks for them', async () => {
      server.authorization = basic('ci:p:ss ş');

      await runAll(backendWith({ CLAY_HTTP_USERNAME: 'ci', CLAY_HTTP_PASSWORD: 'p:ss ş' }));

      expect(server.received.map(({ method, authorization }) => `${method} ${authorization}`)).toEqual(
        ['LOCK', 'GET', 'POST', 'UNLOCK'].map((method) => `${method} ${server.authorization}`)
      );
    });

    it('keeps them out of the settings init remembers', () => {
      const { settings } = backendWith({ CLAY_HTTP_USERNAME: 'ci', CLAY_HTTP_PASSWORD: 'secret' }).choice;

      expect(Object.keys(settings)).toEqual([
        'address',
        'update_method',
        'lock_address',
        'lock_method',
        'unlock_address',
        'unlock_method',
        'retry_max',
        'retry_wait_min',
        'retry_wait_max',
        'timeout',
      ]);
      expect(JSON.stringify(settings)).not.toContain('secret');
    });

    it('sends a username alone with an empty password', async () => {
      await backendWith({ CLAY_HTTP_USERNAME: 'token' }).read();

      expect(server.received[0].authorization).toBe(basic('token:'));
    });

    it.each([
      ['none', {}],
      ['empty ones', { CLAY_HTTP_USERNAME: '', CLAY_HTTP_PASSWORD: '' }],
    ])('sends no credentials with %s', async (_title, env) => {
      await runAll(backendWith(env));

      expect(server.received.map(({ authorization }) => authorization)).toEqual([undefined, undefined, undefined, undefined]);
    });

    it.each([
      ['a password alone', { CLAY_HTTP_PASSWORD: 'secret' }, 'CLAY_HTTP_PASSWORD is set and CLAY_HTTP_USERNAME is not; basic auth sends a password only with a username'],
      ['an empty username', { CLAY_HTTP_USERNAME: '', CLAY_HTTP_PASSWORD: 'secret' }, 'CLAY_HTTP_PASSWORD is set and CLAY_HTTP_USERNAME is not'],
      ['a colon in the username', { CLAY_HTTP_USERNAME: 'c:i', CLAY_HTTP_PASSWORD: 'secret' }, 'CLAY_HTTP_USERNAME holds a colon, which basic auth cannot send in a username'],
    ])('refuses %s before sending anything', (_title, env, message) => {
      expect(() => backendWith(env)).toThrow(message);
      expect(server.received).toEqual([]);
    });

    it('says the server refuses the credentials it was given, and prints none', async () => {
      server.authorization = basic('ci:right');

      const refused = backendWith({ CLAY_HTTP_USERNAME: 'ci', CLAY_HTTP_PASSWORD: 'wrong' }).read();

      await expect(refused).rejects.toThrow(new Error(`GET ${server.url}/state answered 401: the server refuses the credentials in CLAY_HTTP_USERNAME and CLAY_HTTP_PASSWORD`));
    });
  });
});
