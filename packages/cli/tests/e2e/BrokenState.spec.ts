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

  // Each of these was read as a state and planned against: the string ones by the character, the empty one as a crash.
  it.each([
    ['resources that are not a record', '{"version":1,"serial":0,"resources":"oops"}', 'its resources are not a record'],
    ['outputs that are not a record', '{"version":1,"serial":0,"outputs":"oops","resources":{}}', 'its outputs are not a record'],
    ['a resource with no attributes', '{"version":1,"serial":0,"resources":{"local_file.a":{"resourceType":"local_file","name":"a"}}}', '"local_file.a" is not a resource'],
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
