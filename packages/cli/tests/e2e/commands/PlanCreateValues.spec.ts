import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../../src/commands/apply';
import { createPlanCommand } from '../../../src/commands/plan';

const CONFIG = `
variable "token" {
  default   = "s3cr3t"
  sensitive = true
}

resource "local_file" "f" {
  path    = "f.txt"
  content = var.token
}

resource "random_string" "r" {
  length = 8
}
`;

const LISTED = [
  '  + random_string.r will be created',
  '      length: 8',
  '      special: false',
  '      id: (known after apply)',
  '      result: (known after apply)',
  '  + local_file.f will be created',
  '      path: "f.txt"',
  '      content: (sensitive value)',
  '      id: (known after apply)',
];

// The commands read the current directory, so they run from a temp one.
describe('what the plan lists for a resource to create', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-create-values-'));
    await fs.writeFile(path.join(dir, 'main.clay'), CONFIG, 'utf8');
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => printed.push(stripVTControlCharacters(args.join(' '))));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  function listed(): string[] {
    return printed.slice(printed.indexOf(LISTED[0]), printed.indexOf(LISTED[0]) + LISTED.length);
  }

  it('gives each value under its resource in a plan, and hides a sensitive one', async () => {
    await createPlanCommand().parseAsync(['node', 'clay']);

    expect(listed()).toEqual(LISTED);
    expect(printed.join('\n')).not.toContain('s3cr3t');
  });

  it('gives them before an apply runs', async () => {
    await createApplyCommand().parseAsync(['node', 'clay', '--yes']);

    expect(listed()).toEqual(LISTED);
    expect(printed.join('\n')).not.toContain('s3cr3t');
  });

  it('gives them from a saved plan', async () => {
    await createPlanCommand().parseAsync(['node', 'clay', '--out', 'saved.json']);
    printed.length = 0;

    await createApplyCommand().parseAsync(['node', 'clay', 'saved.json']);

    expect(listed()).toEqual(LISTED);
    expect(printed.join('\n')).not.toContain('s3cr3t');
  });
});
