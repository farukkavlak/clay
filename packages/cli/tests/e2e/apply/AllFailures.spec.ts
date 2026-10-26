import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../../src/commands/apply';

const breaks = (name: string) => `resource "command_exec" "${name}" {\n  command = "echo ${name} is broken >&2; exit 1"\n}`;

describe('apply when several actions fail together', () => {
  let dir: string;
  let cwd: string;
  let errors: string[];
  let exitCode: number | undefined;

  const apply = async (config: string) => {
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
    await createApplyCommand().parseAsync(['node', 'clay', '-y']);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-all-failures-'));
    cwd = process.cwd();
    process.chdir(dir);
    errors = [];
    exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('names every one of them', async () => {
    await apply(`${breaks('one')}\n${breaks('two')}`);

    const output = errors.join('\n');
    expect(output).toContain('command_exec.one:');
    expect(output).toContain('one is broken');
    expect(output).toContain('command_exec.two:');
    expect(output).toContain('two is broken');
    expect(errors.at(-1)).toContain('Apply failed: 2 actions failed');
    expect(exitCode).toBe(1);
  });

  it('keeps the single failure line as it was', async () => {
    await apply(breaks('only'));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Apply failed: command_exec\.only: .*only is broken/s);
    expect(exitCode).toBe(1);
  });
});
