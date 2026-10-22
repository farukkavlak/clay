import { STATE_VERSION } from '@clay/contracts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlanCommand } from '../../src/commands/plan';

describe('a state file that is not valid state', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  const planWith = async (state: string) => {
    await fs.writeFile(path.join(dir, 'clay.state.json'), state, 'utf8');
    await createPlanCommand().parseAsync(['node', 'clay']);

    return printed.join('\n');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-broken-state-'));
    await fs.writeFile(path.join(dir, 'main.clay'), `resource "local_file" "a" { path = "${path.join(dir, 'a.txt')}" content = "a" }`, 'utf8');
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    const record = (...args: unknown[]) => printed.push(args.join(' '));
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    // The command exits the process when it fails, which would take the test runner with it.
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['resources that are not a record', `{"version":${STATE_VERSION},"serial":0,"resources":"oops"}`, 'its resources are not a record'],
    ['outputs that are not a record', `{"version":${STATE_VERSION},"serial":0,"outputs":"oops","resources":{}}`, 'its outputs are not a record'],
    [
      'a resource with no attributes',
      `{"version":${STATE_VERSION},"serial":0,"resources":{"local_file.a":{"resourceType":"local_file","name":"a"}}}`,
      '"local_file.a" is not a resource',
    ],
    [
      'a resource whose sensitive parts are not steps',
      `{"version":${STATE_VERSION},"serial":0,"resources":{"local_file.a":{"resourceType":"local_file","name":"a","attributes":{},"sensitive":"content"}}}`,
      '"local_file.a" is not a resource',
    ],
    ['deposed objects that are not a record', `{"version":${STATE_VERSION},"serial":0,"resources":{},"deposed":"oops"}`, 'its deposed objects are not a record'],
    [
      'deposed objects under something that is not an address',
      `{"version":${STATE_VERSION},"serial":0,"resources":{},"deposed":{"nope":[{"attributes":{}}]}}`,
      '"nope" is not the address of a resource, so it cannot hold deposed objects',
    ],
    [
      'an empty list of deposed objects',
      `{"version":${STATE_VERSION},"serial":0,"resources":{},"deposed":{"local_file.a":[]}}`,
      'the deposed objects of "local_file.a" are not a list with an object in it',
    ],
    [
      'a deposed object with no attributes',
      `{"version":${STATE_VERSION},"serial":0,"resources":{},"deposed":{"local_file.a":[{}]}}`,
      'a deposed object of "local_file.a" has no attributes',
    ],
    [
      'a deposed object whose dependencies are not a list',
      `{"version":${STATE_VERSION},"serial":0,"resources":{},"deposed":{"local_file.a":[{"attributes":{},"dependencies":"x"}]}}`,
      'a deposed object of "local_file.a" has no attributes, or its sensitive or dependencies',
    ],
    [
      'a deposed object with a dependency that is not an address',
      `{"version":${STATE_VERSION},"serial":0,"resources":{},"deposed":{"local_file.a":[{"attributes":{},"dependencies":[42]}]}}`,
      'a deposed object of "local_file.a" has no attributes, or its sensitive or dependencies',
    ],
    [
      'a resource with a dependency that is a number',
      `{"version":${STATE_VERSION},"serial":0,"resources":{"local_file.a":{"resourceType":"local_file","name":"a","attributes":{},"dependencies":[42]}}}`,
      '"local_file.a" is not a resource',
    ],
    [
      'a resource with a dependency that is not an address',
      `{"version":${STATE_VERSION},"serial":0,"resources":{"local_file.a":{"resourceType":"local_file","name":"a","attributes":{},"dependencies":["nothing"]}}}`,
      '"local_file.a" is not a resource',
    ],
    [
      'a deposed object whose sensitive parts are not steps',
      `{"version":${STATE_VERSION},"serial":0,"resources":{},"deposed":{"local_file.a":[{"attributes":{},"sensitive":"content"}]}}`,
      'a deposed object of "local_file.a" has no attributes, or its sensitive or dependencies',
    ],
    [
      'a deposed object with a sensitive index that is not whole',
      `{"version":${STATE_VERSION},"serial":0,"resources":{},"deposed":{"local_file.a":[{"attributes":{},"sensitive":[["content",1.5]]}]}}`,
      'a sensitive index of a deposed object of "local_file.a": 1.5 is not a whole number',
    ],
    [
      'a resource whose prevent_destroy is not true',
      `{"version":${STATE_VERSION},"serial":0,"resources":{"local_file.a":{"resourceType":"local_file","name":"a","attributes":{},"preventDestroy":false}}}`,
      '"local_file.a" is not a resource',
    ],
    [
      'a resource with a sensitive index that is not whole',
      `{"version":${STATE_VERSION},"serial":0,"resources":{"local_file.a":{"resourceType":"local_file","name":"a","attributes":{},"sensitive":[["content",1.5]]}}}`,
      'a sensitive index of "local_file.a": 1.5 is not a whole number',
    ],
    [
      'a resource filed under another address',
      `{"version":${STATE_VERSION},"serial":0,"resources":{"local_file.a":{"resourceType":"local_file","name":"b","attributes":{}}}}`,
      '"local_file.a" holds local_file.b',
    ],
    ['no version at all', '{}', 'its version is not a number'],
    ['text that is not json', '{oops', 'the file is not JSON'],
  ])('refuses %s, and says which file', async (_, state, reason) => {
    const output = await planWith(state);

    expect(output).toContain(path.join(dir, 'clay.state.json'));
    expect(output).toContain(reason);
    expect(output).not.toContain('will be destroyed');
  });

  it('refuses a state a newer Clay wrote', async () => {
    expect(await planWith('{"version":99,"serial":0,"resources":{}}')).toContain('was written by a newer Clay, version 99');
  });
});
