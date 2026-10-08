import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlanCommand } from '../../src/commands/plan';

// The tests compile to CommonJS, which has no import.meta.dirname.
// eslint-disable-next-line unicorn/prefer-module
const clay = path.resolve(__dirname, '../../bin/clay.js');

const config = (value: string) => `output "plain" { value = "x" }\noutput "__proto__" { value = "${value}" }`;

describe('an output named after something every object has', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  const clayIn = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
    return stripVTControlCharacters(stdout);
  };

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

  describe('named __proto__', () => {
    it('is planned, applied, kept in state and printed as any other', async () => {
      await fs.writeFile(path.join(dir, 'main.clay'), config('first'), 'utf8');

      const planned = await clayIn('plan');
      const applied = await clayIn('apply', '--yes');
      const read = await clayIn('output');
      const state = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as { outputs: Record<string, { value: unknown }> };

      expect(planned).toContain('+ __proto__ = "first"');
      expect(applied).toContain('Outputs:\n  plain = "x"\n  __proto__ = "first"');
      expect(read).toContain('__proto__ = "first"');
      expect(Object.keys(state.outputs)).toEqual(['plain', '__proto__']);
    });

    it('is changed from a plan saved to a file', async () => {
      await fs.writeFile(path.join(dir, 'main.clay'), config('first'), 'utf8');
      await clayIn('apply', '--yes');
      await fs.writeFile(path.join(dir, 'main.clay'), config('second'), 'utf8');

      const planned = await clayIn('plan', '--out', 'tfplan.json');
      await clayIn('apply', 'tfplan.json');

      expect(planned).toContain('~ __proto__ = "first" -> "second"');
      expect(await clayIn('output')).toContain('__proto__ = "second"');
    });
  });

  it('named __proto__ is no change when it stays, and is taken away when it goes', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), config('first'), 'utf8');
    await clayIn('apply', '--yes');

    const same = await clayIn('plan');
    await fs.writeFile(path.join(dir, 'main.clay'), 'output "plain" { value = "x" }', 'utf8');
    const gone = await clayIn('plan');

    expect(same).toContain('No changes');
    expect(gone).toContain('Changes to outputs:\n\n  - __proto__\n');
  });
});
