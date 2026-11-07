import { emptyState } from '@clay/contracts';
import { BackendBlock, ConfigError, parseModule } from '@clay/parser';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpStateServer } from '../../../tests/httpStateServer';
import { adoptBackend, backendFrom, newLockInfo, rememberedBackend, serializeState, StateBackend, StateManager } from '../src';

const fixture = (name: string) => readFileSync(path.join(__dirname, '../../../tests/tls', name), 'utf8');
const CLIENT = { CLAY_HTTP_CLIENT_CERTIFICATE: fixture('client.pem'), CLAY_HTTP_CLIENT_KEY: fixture('client.key') };

const blockOf = (lines: string[]) => parseModule([{ file: 'main.clay', content: `clay {\n  backend "http" {\n${lines.join('\n')}\n  }\n}` }])[0] as BackendBlock;

const linesFor = (base: string, ...more: string[]) => [`address = "${base}/state"`, `lock_address = "${base}/lock"`, ...more];

/** The record `init` writes, of the backend it took. */
const remember = async (dir: string, backend: StateBackend) => {
  await fs.mkdir(path.join(dir, '.clay'), { recursive: true });
  await fs.writeFile(path.join(dir, '.clay', 'backend.json'), JSON.stringify({ type: backend.choice.type, settings: backend.choice.settings }), 'utf8');
};

/** What `init` does with the backend the block names, in the one environment both backends are built with. */
const adopt = async (dir: string, backend: StateBackend) => {
  const before = rememberedBackend(dir, CLIENT);
  await backend.lock(newLockInfo('init'));
  return adoptBackend(backend, { backend: before, manager: new StateManager(before) }, dir, async () => true);
};

const refusalOf = async (action: () => unknown): Promise<Error> => {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) return error;

    throw error;
  }

  throw new Error('Expected a refusal');
};

describe('TLS settings of the http backend', () => {
  let dir: string;
  let server: HttpStateServer;

  const build = (env: Record<string, string>, ...more: string[]) => backendFrom(blockOf(linesFor(server.url, ...more)), dir, env);
  const reached = () => server.received.map(({ method, path }) => `${method} ${path}`);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-http-tls-'));
    await fs.mkdir(path.join(dir, 'certs'));
    await fs.writeFile(path.join(dir, 'certs', 'ca.pem'), fixture('ca.pem'), 'utf8');
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('ca_certificate', () => {
    beforeEach(async () => {
      server = await HttpStateServer.start({ tls: true });
    });

    it('is a file read from the configuration directory, and its CAs are trusted', async () => {
      await build({}, 'ca_certificate = "certs/ca.pem"').read();

      expect(reached()).toEqual(['GET /state']);
    });

    it('is read once a command, so every request of a run trusts the same CAs', async () => {
      const backend = build({}, 'ca_certificate = "certs/ca.pem"');
      await backend.read();
      await fs.rm(path.join(dir, 'certs', 'ca.pem'));

      await backend.read();

      expect(reached()).toEqual(['GET /state', 'GET /state']);
    });

    it('takes the text openssl prints between blocks', async () => {
      await fs.writeFile(path.join(dir, 'certs', 'ca.pem'), `Bag Attributes\n    friendlyName: clay\n${fixture('ca.pem')}`, 'utf8');

      await build({}, 'ca_certificate = "certs/ca.pem"').read();

      expect(reached()).toEqual(['GET /state']);
    });

    it('is remembered by the name it was given, not by what the file holds', () => {
      expect(build({}, 'ca_certificate = "certs/ca.pem"').choice.settings).toMatchObject({ ca_certificate: 'certs/ca.pem' });
    });

    it('is read at the first request, so a file gone stops no backend from being built', async () => {
      const backend = build({}, 'ca_certificate = "certs/gone.pem"');

      const error = await refusalOf(() => backend.read());

      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toBe(`ca_certificate of backend "http" is "certs/gone.pem", and ${path.join(dir, 'certs', 'gone.pem')} cannot be read (ENOENT)`);
      expect((error as ConfigError).position).toMatchObject({ line: 5, column: 18 });
      expect(reached()).toEqual([]);
    });

    it('is refused where the file holds no certificate', async () => {
      await fs.writeFile(path.join(dir, 'certs', 'ca.pem'), 'not a certificate\n', 'utf8');

      const error = await refusalOf(() => build({}, 'ca_certificate = "certs/ca.pem"').read());

      expect(error.message).toBe(`ca_certificate of backend "http" is "certs/ca.pem", and ${path.join(dir, 'certs', 'ca.pem')} holds no PEM certificate`);
    });

    it('is refused where a block in the file is no certificate', async () => {
      await fs.writeFile(path.join(dir, 'certs', 'ca.pem'), fixture('ca.pem') + fixture('server.key'), 'utf8');

      const error = await refusalOf(() => build({}, 'ca_certificate = "certs/ca.pem"').read());

      expect(error.message).toMatch(/and \S+ holds a PRIVATE KEY block, where only certificates are taken$/);
    });

    it('is refused where a block has no END line', async () => {
      await fs.writeFile(path.join(dir, 'certs', 'ca.pem'), `${fixture('ca.pem')}-----BEGIN CERTIFICATE-----\nMIIB\n`, 'utf8');

      const error = await refusalOf(() => build({}, 'ca_certificate = "certs/ca.pem"').read());

      expect(error.message).toMatch(/and \S+ holds a PEM block with no END line$/);
    });

    it('is refused where a certificate in the file cannot be read, though another can', async () => {
      await fs.writeFile(path.join(dir, 'certs', 'ca.pem'), `${fixture('ca.pem')}-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n`, 'utf8');

      const error = await refusalOf(() => build({}, 'ca_certificate = "certs/ca.pem"').read());

      expect(error.message).toMatch(/and \S+ holds a certificate that cannot be read \(ERR_OSSL_[A-Z0-9_]+\)$/);
      expect(reached()).toEqual([]);
    });

    it('is refused at its value where no address is https', async () => {
      const error = await refusalOf(() => backendFrom(blockOf(linesFor('http://127.0.0.1:1', 'ca_certificate = "certs/ca.pem"')), dir, {}));

      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toBe('ca_certificate of backend "http" is given, and no address is https, so no CA would be asked');
      expect((error as ConfigError).position).toMatchObject({ line: 5, column: 18 });
    });

    it('stops a backend built from the record with a plain error, as the record is what init wrote', async () => {
      await fs.mkdir(path.join(dir, '.clay'));
      const { settings } = build({}, 'ca_certificate = "certs/ca.pem"').choice;
      await fs.writeFile(path.join(dir, '.clay', 'backend.json'), JSON.stringify({ type: 'http', settings }), 'utf8');
      await fs.rm(path.join(dir, 'certs', 'ca.pem'));

      const error = await refusalOf(() => rememberedBackend(dir, {}).read());

      expect(error).not.toBeInstanceOf(ConfigError);
      expect(error.message).toBe(`ca_certificate of backend "http" is "certs/ca.pem", and ${path.join(dir, 'certs', 'ca.pem')} cannot be read (ENOENT)`);
    });
  });

  describe('a client certificate', () => {
    beforeEach(async () => {
      server = await HttpStateServer.start({ tls: true, askClient: true });
    });

    it('is shown to a server that asks for it', async () => {
      await build(CLIENT, 'ca_certificate = "certs/ca.pem"').read();

      expect(reached()).toEqual(['GET /state']);
    });

    it('is kept out of the settings init remembers', () => {
      expect(JSON.stringify(build(CLIENT, 'ca_certificate = "certs/ca.pem"').choice)).not.toContain('PRIVATE KEY');
      expect(JSON.stringify(build(CLIENT, 'ca_certificate = "certs/ca.pem"').choice)).not.toContain('BEGIN CERTIFICATE');
    });

    it.each([
      ['CLAY_HTTP_CLIENT_CERTIFICATE', 'CLAY_HTTP_CLIENT_KEY'],
      ['CLAY_HTTP_CLIENT_KEY', 'CLAY_HTTP_CLIENT_CERTIFICATE'],
    ])('is refused where %s is set and %s is not', async (set, unset) => {
      const error = await refusalOf(() => build({ [set]: CLIENT[set as keyof typeof CLIENT] }));

      expect(error.message).toBe(`${set} is set and ${unset} is not; a client certificate is sent only with its key`);
    });

    it('is refused where the key is not the certificate’s', async () => {
      const error = await refusalOf(() => build({ ...CLIENT, CLAY_HTTP_CLIENT_KEY: fixture('server.key') }));

      expect(error.message).toBe('CLAY_HTTP_CLIENT_KEY is not the key of the first certificate in CLAY_HTTP_CLIENT_CERTIFICATE');
    });

    it('is refused where the key is encrypted', async () => {
      const { privateKey } = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'secret' },
      });

      const error = await refusalOf(() => build({ ...CLIENT, CLAY_HTTP_CLIENT_KEY: privateKey }));

      expect(error.message).toBe('CLAY_HTTP_CLIENT_KEY holds an encrypted key; Clay asks for no passphrase, so give the key unencrypted');
    });

    it('is refused where the key cannot be read', async () => {
      const error = await refusalOf(() => build({ ...CLIENT, CLAY_HTTP_CLIENT_KEY: 'not a key' }));

      expect(error.message).toMatch(/^CLAY_HTTP_CLIENT_KEY holds no private key Clay can read \(ERR_OSSL_[A-Z0-9_]+\)$/);
    });

    it('is refused where the certificate is no PEM', async () => {
      const error = await refusalOf(() => build({ ...CLIENT, CLAY_HTTP_CLIENT_CERTIFICATE: 'not a certificate' }));

      expect(error.message).toBe('CLAY_HTTP_CLIENT_CERTIFICATE holds no PEM certificate');
    });

    it('is not shown, nor refused, where no address is https', async () => {
      const plain = await HttpStateServer.start();
      try {
        await backendFrom(blockOf(linesFor(plain.url)), dir, CLIENT).read();

        expect(plain.received.map(({ method, path }) => `${method} ${path}`)).toEqual(['GET /state']);
      } finally {
        await plain.stop();
      }
    });

    describe('while init moves the state', () => {
      let plain: HttpStateServer;

      beforeEach(async () => {
        plain = await HttpStateServer.start();
      });

      afterEach(async () => {
        await plain.stop();
      });

      it('takes it from a plain http server to one that asks for the certificate', async () => {
        plain.state = serializeState({ ...emptyState(), serial: 4 });
        await remember(dir, backendFrom(blockOf(linesFor(plain.url)), dir, CLIENT));

        await adopt(dir, build(CLIENT, 'ca_certificate = "certs/ca.pem"'));

        expect(JSON.parse(server.state!)).toMatchObject({ serial: 4 });
      });

      it('takes it back to the plain http server', async () => {
        server.state = serializeState({ ...emptyState(), serial: 4 });
        await remember(dir, build(CLIENT, 'ca_certificate = "certs/ca.pem"'));

        await adopt(dir, backendFrom(blockOf(linesFor(plain.url)), dir, CLIENT));

        expect(JSON.parse(plain.state!)).toMatchObject({ serial: 4 });
      });
    });

    it.each([
      ['client_certificate', 'CLAY_HTTP_CLIENT_CERTIFICATE'],
      ['client_private_key', 'CLAY_HTTP_CLIENT_KEY'],
    ])('is refused in the block as %s, naming %s', async (name, variable) => {
      const error = await refusalOf(() => build({}, `${name} = "x"`));

      expect(error).toBeInstanceOf(ConfigError);
      expect(error.message).toBe(`${name} of backend "http" is read from ${variable}, never from the configuration, which is checked in`);
    });
  });
});
