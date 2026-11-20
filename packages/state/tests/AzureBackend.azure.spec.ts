import { emptyState } from '@clay/core';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RealAzure } from '../../../tests/realAzure';
import { newLockInfo, serializeState, StateLocked } from '../src';
import { AzureBackend } from '../src/backends/AzureBackend';

const resource = { resourceType: 'local_file', name: 'a', attributes: { path: 'a.txt' } };
const stateWith = (serial: number) => ({ ...emptyState(), serial, lineage: 'lineage-a', resources: { 'local_file.a': resource } });

const KEY = 'env/state.json';
const LOCK = `${KEY}.lock`;

describe('a state kept on a real Azure Blob server', () => {
  let azure: RealAzure;
  let container = '';

  const backendIn = (name = container) =>
    new AzureBackend(
      { account: azure.account, container: name, key: KEY, endpoint: new URL(azure.endpoint), credential: { accountKey: azure.accountKey } },
      { timeout: 10, attempts: 1, wait: 0 }
    );

  const on = (key: string) =>
    new AzureBackend(
      { account: azure.account, container, key, endpoint: new URL(azure.endpoint), credential: { accountKey: azure.accountKey } },
      { timeout: 10, attempts: 1, wait: 0 }
    );

  beforeAll(() => {
    azure = RealAzure.fromEnv();
  });

  beforeEach(async () => {
    container = '';
    container = await azure.newContainer();
  });

  afterEach(async () => {
    if (container !== '') await azure.removeContainer(container);
  });

  it('writes the state whole and reads it back', async () => {
    expect(await backendIn().exists()).toBe(false);

    await backendIn().write(stateWith(3));

    expect(await azure.text(container, KEY)).toBe(serializeState(stateWith(3)));
    expect(await backendIn().read()).toEqual(stateWith(3));
  });

  it('writes a first state only where none is', async () => {
    expect(await backendIn().writeIfAbsent(stateWith(1))).toBe(true);
    expect(await backendIn().writeIfAbsent(stateWith(2))).toBe(false);

    expect(await azure.text(container, KEY)).toBe(serializeState(stateWith(1)));
  });

  it('names a container the server does not have', async () => {
    await expect(backendIn(`clay-missing-${randomUUID()}`).check()).rejects.toThrow('answered 404 ContainerNotFound');
  });

  describe('its lock', () => {
    it('is taken by one of many runs that try at once, and refused to the rest naming it', async () => {
      const runs = Array.from({ length: 10 }, () => newLockInfo('apply'));

      const tries = await Promise.allSettled(runs.map((info) => backendIn().lock(info)));

      const taken = runs.filter((_info, at) => tries[at].status === 'fulfilled');
      expect(taken).toHaveLength(1);
      expect(JSON.parse((await azure.text(container, LOCK))!)).toEqual(taken[0]);
      for (const refused of tries.filter((each) => each.status === 'rejected')) {
        expect(refused.reason).toBeInstanceOf(StateLocked);
        expect(refused.reason.message).toContain(`pid ${taken[0].pid}`);
      }
    });

    it('is released by the run that took it', async () => {
      const info = newLockInfo('apply');
      await backendIn().lock(info);

      await backendIn().unlock(info.id);

      expect(await azure.text(container, LOCK)).toBeUndefined();
      await backendIn().lock(newLockInfo('plan'));
    });

    it('counts as released where it was removed by hand', async () => {
      const info = newLockInfo('apply');
      await backendIn().lock(info);
      await azure.remove(container, LOCK);

      await expect(backendIn().unlock(info.id)).resolves.toBeUndefined();
    });

    it('is left in place where another run holds it', async () => {
      const other = newLockInfo('plan');
      await backendIn().lock(other);

      await expect(backendIn().unlock(newLockInfo('apply').id)).rejects.toThrow('holds a lock this run did not take, so it is left in place');
      expect(JSON.parse((await azure.text(container, LOCK))!)).toEqual(other);
    });
  });

  describe('its workspaces', () => {
    const FOLDER = 'env/ş p&q';

    it('lists only the states of the default file name, under a key that needs escaping', async () => {
      const made = on(`${FOLDER}/state.json`).workspace('dev');
      await made.prepare();
      await made.lock(newLockInfo('workspace new'));
      expect(await made.writeIfAbsent(stateWith(1))).toBe(true);
      await azure.put(container, `${FOLDER}/clay.workspaces/other/b.json`, '{}');
      await azure.put(container, `${FOLDER}/clay.workspaces/empty/state.json`, '');

      expect(await azure.text(container, `${FOLDER}/clay.workspaces/dev/state.json`)).toBe(serializeState(stateWith(1)));
      expect(await on(`${FOLDER}/state.json`).listWorkspaces()).toEqual(['default', 'dev']);
    });

    it('is gone once removed, and refuses a lock then', async () => {
      await azure.put(container, 'env/clay.workspaces/dev/state.json', serializeState(stateWith(1)));
      const workspace = on(KEY).workspace('dev');

      await workspace.remove();

      expect(await workspace.exists()).toBe(false);
      await expect(on(KEY).workspace('dev').lock(newLockInfo('apply'))).rejects.toThrow('Workspace "dev" does not exist');
      expect(await azure.text(container, 'env/clay.workspaces/dev/state.json.lock')).toBeUndefined();
    });
  });
});
