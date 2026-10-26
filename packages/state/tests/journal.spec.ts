import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';

import { emptyState, Resource, State, STATE_VERSION } from '@clay/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalBackend } from '../src/backends/LocalBackend';
import { StateBackend } from '../src/StateBackend';
import { StateManager } from '../src/StateManager';

const resource = (name: string, content = name): Resource => ({ resourceType: 'rt', name, attributes: { content } });

describe('the journal', () => {
  let tmpDir: string;
  let manager: StateManager;
  let state: State;

  const statePath = () => path.join(tmpDir, 'clay.state.json');
  const journalPath = () => `${statePath()}.journal`;
  const journal = () => fs.readFile(journalPath(), 'utf8');
  const heldKeys = async () => {
    const read = await manager.read();
    return Object.keys(read.resources);
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-journal-'));
    manager = new StateManager(new LocalBackend(tmpDir));
    state = emptyState();
    state.resources['rt.a'] = resource('a');
    await manager.write(state);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('a recorded address', () => {
    it('is read back with the state, which is not written', async () => {
      const before = await fs.readFile(statePath(), 'utf8');
      state.resources['rt.b'] = resource('b');

      await manager.record(state, 'rt.b');

      expect(await fs.readFile(statePath(), 'utf8')).toBe(before);
      expect(await manager.read()).toEqual(state);
    });

    it('takes one line, whatever the state holds', async () => {
      const big = emptyState();
      for (let index = 0; index < 50; index++) big.resources[`rt.r${index}`] = resource(`r${index}`);
      await manager.write(big);

      await manager.record({ ...big, resources: { ...big.resources, 'rt.b': resource('b') } }, 'rt.b');

      const written = await journal();
      const lines = written.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe('');
      expect(lines[0]).not.toContain('r49');
    });

    it('counts in the serial, as a whole write does', async () => {
      await manager.record(state, 'rt.a');
      await manager.record(state, 'rt.a');

      const read = await manager.read();
      expect(state.serial).toBe(3);
      expect(read.serial).toBe(3);
    });

    // A failed append may leave part of a line, which the next line would follow.
    it.skipIf(process.getuid?.() === 0)('is written whole after an append failed, and appended again after that', async () => {
      await fs.writeFile(journalPath(), '');
      await fs.chmod(journalPath(), 0o444);
      state.resources['rt.b'] = resource('b');
      await expect(manager.record(state, 'rt.b')).rejects.toMatchObject({ code: 'EACCES' });
      expect(state.serial).toBe(1);

      await manager.record(state, 'rt.b');

      await expect(fs.stat(journalPath())).rejects.toThrow(/ENOENT/);
      const written = JSON.parse(await fs.readFile(statePath(), 'utf8')) as State;
      expect(Object.keys(written.resources)).toEqual(['rt.a', 'rt.b']);
      expect(written.serial).toBe(2);

      await manager.record(state, 'rt.b');
      expect(await journal()).toContain('"serial":3');
    });

    it('goes from the state once it holds nothing there', async () => {
      delete state.resources['rt.a'];

      await manager.record(state, 'rt.a');

      expect(await heldKeys()).toEqual([]);
    });

    it('keeps the deposed objects it has, and drops them once there are none', async () => {
      state.deposed = { 'rt.a': [{ attributes: { content: 'old' } }] };
      await manager.record(state, 'rt.a');
      expect(await manager.read()).toHaveProperty('deposed', { 'rt.a': [{ attributes: { content: 'old' } }] });

      delete state.deposed;
      await manager.record(state, 'rt.a');

      expect(await manager.read()).not.toHaveProperty('deposed');
    });

    it('holds what the address holds when its turn comes, after the write before it', async () => {
      state.resources['rt.b'] = resource('b');
      const writing = manager.write(state);
      state.resources['rt.c'] = resource('c');
      const recording = manager.record(state, 'rt.c');
      await Promise.all([writing, recording]);

      expect(await heldKeys()).toEqual(['rt.a', 'rt.b', 'rt.c']);
    });
  });

  describe('a whole write', () => {
    it('takes the journal into the state and removes it', async () => {
      state.resources['rt.b'] = resource('b');
      await manager.record(state, 'rt.b');

      await manager.write(state);

      await expect(fs.stat(journalPath())).rejects.toThrow(/ENOENT/);
      const written = JSON.parse(await fs.readFile(statePath(), 'utf8')) as State;
      expect(Object.keys(written.resources)).toEqual(['rt.a', 'rt.b']);
    });
  });

  describe('a journal left by a run that stopped', () => {
    it('is in the backup the next run takes', async () => {
      state.resources['rt.b'] = resource('b');
      await manager.record(state, 'rt.b');
      const stopped = structuredClone(state);

      await manager.lock();
      await manager.write(emptyState());

      const backup = JSON.parse(await fs.readFile(`${statePath()}.bak`, 'utf8')) as State;
      expect(backup).toEqual(stopped);
    });

    it('is read without its last line where that line was cut short', async () => {
      state.resources['rt.b'] = resource('b');
      await manager.record(state, 'rt.b');
      await fs.appendFile(journalPath(), '{"serial":1,"key":"rt.c","reso');

      expect(await heldKeys()).toEqual(['rt.a', 'rt.b']);
    });

    it.each([0, 1])('skips a line of serial %i, which the whole write at serial 1 already holds', async (serial) => {
      await fs.writeFile(journalPath(), `${JSON.stringify({ serial, key: 'rt.b', resource: resource('b'), deposed: null })}\n`);

      expect(await heldKeys()).toEqual(['rt.a']);
    });

    it('is refused where a line does not follow the serial before it', async () => {
      await fs.writeFile(journalPath(), `${JSON.stringify({ serial: 3, key: 'rt.b', resource: resource('b'), deposed: null })}\n`);

      await expect(manager.read()).rejects.toThrow(`${journalPath()} is not a valid journal: line 1 has serial 3, but the state before it has 1`);
    });

    it('is not read where the state is of a newer Clay', async () => {
      await fs.writeFile(statePath(), JSON.stringify({ version: STATE_VERSION + 1, serial: 1, resources: {} }));
      await fs.writeFile(journalPath(), '[]\n');

      await expect(manager.read()).rejects.toThrow(`${statePath()} was written by a newer Clay, version ${STATE_VERSION + 1}`);
    });

    it('is refused where it cannot be read', async () => {
      await fs.mkdir(journalPath());

      await expect(manager.read()).rejects.toMatchObject({ code: 'EISDIR' });
    });

    it('is refused where a line before the last is not JSON', async () => {
      await fs.writeFile(journalPath(), `{"serial":1,\n${JSON.stringify({ serial: 1, key: 'rt.b', resource: resource('b'), deposed: null })}\n`);

      await expect(manager.read()).rejects.toThrow(`${journalPath()} is not a valid journal: line 1 is not JSON`);
    });

    it.each([
      ['is no entry', '[]', 'line 1 is not an entry'],
      ['has a serial that is no number', JSON.stringify({ serial: 'one', key: 'rt.b', resource: null, deposed: null }), 'the serial of line 1 is not a number'],
      ['names no address', JSON.stringify({ serial: 1, key: 'b', resource: null, deposed: null }), 'line 1 names "b", which is not the address of a resource'],
      ['says nothing of deposed objects', JSON.stringify({ serial: 2, key: 'rt.b', resource: null }), 'line 1 does not say both what rt.b holds and what it left deposed'],
      [
        'has a serial past what a number holds exactly',
        `{"serial":1e30,"key":"rt.b","resource":null,"deposed":null}`,
        'line 1: its serial: 1000000000000000000000000000000 is outside the range -9007199254740991 to 9007199254740991',
      ],
      [
        'is nested deeper than a file may be',
        `{"serial":2,"key":"rt.b","resource":${'['.repeat(600)}${']'.repeat(600)},"deposed":null}`,
        'line 1: it is nested more than 500 levels deep',
      ],
      ['holds no resource', JSON.stringify({ serial: 2, key: 'rt.b', resource: { name: 'b' }, deposed: null }), 'line 1: "rt.b" is not a resource'],
      ['holds the resource of another address', JSON.stringify({ serial: 2, key: 'rt.b', resource: resource('c'), deposed: null }), 'line 1: "rt.b" holds rt.c'],
      [
        'holds an empty list of deposed objects',
        JSON.stringify({ serial: 2, key: 'rt.b', resource: null, deposed: [] }),
        'line 1: the deposed objects of "rt.b" are not a list with an object in it',
      ],
    ])('is refused where a line %s', async (_, line, problem) => {
      await fs.writeFile(journalPath(), `${line}\n`);

      await expect(manager.read()).rejects.toThrow(`${journalPath()} is not a valid journal: ${problem}`);
    });
  });

  describe('a backend that keeps no journal', () => {
    it('is written whole', async () => {
      const written: State[] = [];
      const whole: StateBackend = {
        read: async () => emptyState(),
        writeIfAbsent: () => Promise.resolve(true),
        lock: () => Promise.resolve(),
        unlock: () => Promise.resolve(),
        write: async (given) => {
          written.push(structuredClone(given));
        },
      };
      state.resources['rt.b'] = resource('b');

      await new StateManager(whole).record(state, 'rt.b');

      expect(written.map((given) => Object.keys(given.resources))).toEqual([['rt.a', 'rt.b']]);
    });
  });
});
