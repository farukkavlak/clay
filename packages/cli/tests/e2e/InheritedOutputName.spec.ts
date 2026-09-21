import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlanCommand } from '../../src/commands/plan';

describe('an output named after something every object has', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-inherited-output-'));
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void printed.push(args.join(' ')));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is shown as an addition, not as a change from a value nobody wrote', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), 'output "constructor" { value = "hello" }', 'utf8');

    await createPlanCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('+ constructor = "hello"');
  });
});
