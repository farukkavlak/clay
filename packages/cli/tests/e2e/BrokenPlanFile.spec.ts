import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PLAN_FILE_VERSION } from '@clay/planner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';

describe('a plan file that cannot be read', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];
  let exitCodes: number[];

  const applyWith = async (planFile: string) => {
    await createApplyCommand().parseAsync(['node', 'clay', planFile]);

    return printed.join('\n');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-broken-plan-'));
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    const record = (...args: unknown[]) => printed.push(args.join(' '));
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'error').mockImplementation(record);
    exitCodes = [];
    // The command exits the process when it fails, which would take the test runner with it.
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => void exitCodes.push(code)) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Each of these reached the user as whatever Node threw: a JSON parser message, or an ENOENT.
  it.each([
    ['text that is not json', '{oops', 'tfplan.json is not a plan file: the file is not JSON'],
    ['json of the wrong shape', JSON.stringify({ version: PLAN_FILE_VERSION, actions: [] }), 'tfplan.json is not a plan file'],
    ['a plan another version wrote', '{"version":"4.0","actions":[]}', 'tfplan.json was written by another Clay, plan version 4.0'],
  ])('says what is wrong with %s, and what to do about it', async (_, content, reason) => {
    await fs.writeFile(path.join(dir, 'tfplan.json'), content, 'utf8');

    const output = await applyWith('tfplan.json');

    expect(output).toContain(reason);
    expect(output).toContain('Run `clay plan --out <file>` again');
    expect(output).not.toContain('JSON at position');
    expect(exitCodes).toEqual([1]);
  });

  // Planning again is no answer to a name that is not there, so that one branch says only what is wrong.
  it('says a plan file it cannot find is not there, rather than reporting an open that failed', async () => {
    const output = await applyWith('nosuch.json');

    expect(output).toContain('nosuch.json not found');
    expect(output).not.toContain('ENOENT');
    expect(output).not.toContain('Run `clay plan');
    expect(exitCodes).toEqual([1]);
  });
});
