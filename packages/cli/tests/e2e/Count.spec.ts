import { types } from '@clay/contracts';
import { DiskFiles, Orchestrator, RunEvent } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { parsePlanFile, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

/** The line and column `needle` is first written at, as an error would point at it. */
const placeOf = (config: string, needle: string) => {
  const before = config.slice(0, config.indexOf(needle)).split('\n');
  return { line: before.length, column: before.at(-1)!.length + 1 };
};

describe('a resource with count', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  /** Applies the config and returns what it did, in order. */
  const apply = async (config: string): Promise<RunEvent[]> => {
    const events: RunEvent[] = [];
    for await (const event of start(newOrchestrator(), config)) {
      if (event.type === 'failed') throw event.error;
      events.push(event);
    }
    return events;
  };

  const logs = (count: string, word = 'log') => `
    resource "local_file" "logs" {
      count = ${count}
      path = "${path.join(dir, 'log-${count.index}.txt')}"
      content = "${word} \${count.index}"
    }
  `;

  const files = async () => {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith('.txt')).sort();
  };

  const stateKeys = async () => {
    const state = await new LocalBackend(dir).read();
    return Object.keys(state.resources).sort();
  };

  /** As many instances of logs as `count` says, and a resource that reads the first. */
  const withReader = (count: string, word = 'log') => `${logs(count, word)}
    resource "local_file" "reader" {
      path = "${path.join(dir, 'reader.txt')}"
      content = "\${local_file.logs[0].content}"
    }
  `;

  const planError = async (config: string): Promise<ConfigError> => {
    try {
      await newOrchestrator().plan(config);
    } catch (error) {
      if (error instanceof ConfigError) return error;

      throw error;
    }

    throw new Error('Expected the plan to fail');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-count-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('makes one of it for each index, each with its own count.index', async () => {
    await apply(logs('3'));

    expect(await files()).toEqual(['log-0.txt', 'log-1.txt', 'log-2.txt']);
    expect(await fs.readFile(path.join(dir, 'log-2.txt'), 'utf8')).toBe('log 2');
    expect(await stateKeys()).toEqual(['local_file.logs[0]', 'local_file.logs[1]', 'local_file.logs[2]']);
  });

  it('reads count from a variable', async () => {
    await apply(`variable "n" { default = 2 }\n${logs('var.n')}`);

    expect(await files()).toEqual(['log-0.txt', 'log-1.txt']);
  });

  it('deletes the instances past a lower count, and every one at a count of 0', async () => {
    await apply(logs('3'));

    await apply(logs('2'));
    expect(await files()).toEqual(['log-0.txt', 'log-1.txt']);

    await apply(logs('0'));
    expect(await files()).toEqual([]);
    expect(await stateKeys()).toEqual([]);
  });

  it('gives one instance to a resource and an output that read it', async () => {
    const config = `${logs('2')}
      resource "local_file" "reader" {
        path = "${path.join(dir, 'reader.txt')}"
        content = "\${local_file.logs[1].content}"
      }
      output "first" { value = "\${local_file.logs[0].content}" }
    `;

    const events = await apply(config);

    expect(await fs.readFile(path.join(dir, 'reader.txt'), 'utf8')).toBe('log 1');
    expect(events.at(-1)).toEqual({ type: 'done', outputs: { first: { value: 'log 0', type: types.string } } });
  });

  // Only the new instance is unknown; the one read is in state, so its reader has nothing to change.
  it('plans a reader of an instance that stays as it is with nothing to do', async () => {
    await apply(withReader('1'));

    const plan = await newOrchestrator().plan(withReader('2'));

    expect(plan.actions.map((action) => [action.type, action.name, action.key])).toEqual([
      ['NO_OP', 'logs', 0],
      ['CREATE', 'logs', 1],
      ['NO_OP', 'reader', undefined],
    ]);
  });

  it('plans a reader of an instance that changes with the value it changes to', async () => {
    await apply(withReader('1'));

    const plan = await newOrchestrator().plan(withReader('1', 'new'));

    const reader = plan.actions.find((action) => action.name === 'reader');
    expect(reader?.type).toBe('UPDATE');
    expect(reader?.changes?.content.new).toBe('new 0');
  });

  it('deletes a reader before the instances it read', async () => {
    await apply(withReader('2'));

    const events = await apply('');

    const deleted = events.filter((event) => event.type === 'applied').map((event) => (event.type === 'applied' ? event.action.name : ''));
    expect(deleted[0]).toBe('reader');
    expect(deleted).toHaveLength(3);
  });

  it('runs a saved plan instance by instance', async () => {
    const config = logs('2');
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

    for await (const event of newOrchestrator().runPlan(saved, config)) if (event.type === 'failed') throw event.error;

    expect(await files()).toEqual(['log-0.txt', 'log-1.txt']);
  });

  it('refuses a saved plan whose instances its configuration does not make', async () => {
    const saved = await newOrchestrator().plan(logs('1'));
    const without = `resource "local_file" "logs" { path = "${path.join(dir, 'log.txt')}" content = "x" }`;

    const run = async () => {
      for await (const event of newOrchestrator().runPlan(saved, without)) if (event.type === 'failed') throw event.error;
    };

    await expect(run()).rejects.toThrow('The plan has "local_file.logs[0]", which the configuration does not declare');
  });

  it.each([
    ['all of it where one is read', 'local_file.logs.content', 'local_file.logs has count, so name one of it by index, as in local_file.logs[0]'],
    ['an index past its count', 'local_file.logs[2].content', 'local_file.logs has 2 instances, [0] to [1]'],
    ['an index of a resource that has no count', 'local_file.single[0].content', 'local_file.single has no count, so it takes no index'],
    ['an instance with no attribute', 'local_file.logs[0]', 'Resource reference must include attribute: local_file.logs[0]'],
    ['an instance with a second index where the attribute goes', 'local_file.logs[0][1]', 'Reference "local_file.logs[0][1]" has an index where it needs a name'],
    [
      'an instance with a key that is no name where the attribute goes',
      'local_file.logs[0]["tags.env"]',
      'Reference "local_file.logs[0]["tags.env"]" has "tags.env" where it needs a name',
    ],
    ['a key where the index goes', 'local_file.logs["blog"].content', 'local_file.logs has count, so name one of it by index, as in local_file.logs[0]'],
  ])('refuses a reference to %s, where it is written', async (_, reference, message) => {
    const config = `${logs('2')}
      resource "local_file" "single" { path = "${path.join(dir, 'single.txt')}" content = "x" }
      output "o" { value = "\${${reference}}" }
    `;

    const error = await planError(config);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject(placeOf(config, reference));
  });

  it.each([
    ['a resource that has no count', 'resource "local_file" "a" { path = "a" content = "${count.index}" }'],
    ['an output', 'output "o" { value = "${count.index}" }'],
    ['the count it would come from', 'resource "local_file" "a" { count = "${count.index}" path = "a" content = "a" }'],
    ['a data source', 'data "local_file" "d" { path = "${count.index}" }'],
    // The output is not read at plan time, since it waits on a value only an apply makes.
    ['an output that also reads a value still to come', 'resource "random_string" "s" { length = 4 }\noutput "o" { value = "${count.index}-${random_string.s.id}" }'],
  ])('refuses count.index in %s, where it is written', async (_, config) => {
    const error = await planError(config);

    expect(error.message).toBe('count.index is only known inside a resource or a module call that has count');
    expect(error.position).toMatchObject(placeOf(config, 'count.index'));
  });

  it('refuses a count that reads a resource the configuration does not declare', async () => {
    const config = logs('local_file.nowhere.id');

    const error = await planError(config);

    expect(error.message).toBe('"local_file.nowhere" is not declared in the configuration');
    expect(error.position).toMatchObject(placeOf(config, 'local_file.nowhere'));
  });

  it.each([
    ['a negative number', '-1', 'count is a whole number from 0, not -1'],
    ['a fraction', '1.5', 'count: 1.5 is not a whole number'],
    ['a string', '"3"', 'count is a whole number from 0, not a string'],
    ['a value only an apply makes', 'random_string.s.id', 'count must be known when planning: it reads a value only an apply makes'],
  ])('refuses a count that is %s, where it is written', async (_, count, message) => {
    const config = `resource "random_string" "s" { length = 4 }\n${logs(count)}`;

    const error = await planError(config);

    expect(error.message).toBe(message);
    expect(error.position).toMatchObject(placeOf(config, `count = ${count}`.slice('count = '.length)));
  });

  // The configuration sets the length, so the plan knows it before the string is made.
  it('reads count from what the configuration sets on a resource still to be created', async () => {
    await apply(`resource "random_string" "s" { length = 3 }\n${logs('random_string.s.length')}`);

    expect(await files()).toEqual(['log-0.txt', 'log-1.txt', 'log-2.txt']);
  });
});
