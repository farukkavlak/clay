import { emptyState } from '@clay/contracts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getCACertificates } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';

import { HttpStateServer } from '../../../tests/httpStateServer';
import { serializeState } from '../src';
import { trusted } from '../src/backends/httpRequest';
import { backendAt } from './backendAt';

describe('the CAs an https request trusts', () => {
  let server: HttpStateServer | undefined;

  afterEach(async () => {
    await server?.stop();
  });

  it('are those of the system store too, beside the ones Node brings', () => {
    const system = getCACertificates('system');

    expect(system.length).toBeGreaterThan(0);
    expect(trusted()()).toEqual(expect.arrayContaining([...getCACertificates('default'), ...system]));
  });

  it('are the ones the backend is given', async () => {
    server = await HttpStateServer.start({ tls: true });
    server.state = serializeState({ ...emptyState(), serial: 3 });
    const testCa = readFileSync(path.join(__dirname, '../../../tests/tls/ca.pem'), 'utf8');

    await expect(backendAt(server.url, {}, 'state', undefined, undefined, () => [testCa]).read()).resolves.toMatchObject({ serial: 3 });
    expect(server.received.map(({ method, path }) => `${method} ${path}`)).toEqual(['GET /state']);
  });
});
