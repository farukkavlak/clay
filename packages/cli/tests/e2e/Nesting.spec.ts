import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
// The tests compile to CommonJS, which has no import.meta.dirname.
// eslint-disable-next-line unicorn/prefer-module
const clay = path.resolve(__dirname, '../../bin/clay.js');

const deep = (open: string, inner: string, close: string, levels: number) => open.repeat(levels) + inner + close.repeat(levels);

function nestedMap(levels: number): unknown {
  let value: unknown = 1;
  for (let level = 0; level < levels; level++) value = { a: value };
  return value;
}

function nestedList(levels: number, inner: unknown): unknown {
  let value = inner;
  for (let level = 0; level < levels; level++) value = [value];
  return value;
}

// The deepest value the parser takes, through every step that walks a value.
describe('a value nested as deep as the parser takes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-nesting-'));
    const config = `
      variable "v" {
        type    = ${deep('list(', 'string', ')', 100)}
        default = ${deep('[', '"s"', ']', 100)}
      }
      locals {
        maps  = ${deep('{a=', '1', '}', 100)}
        calls = ${deep('tolist(', '[1]', ')', 99)}
      }
      resource "local_file" "f" {
        path    = "${path.join(dir, 'f.txt')}"
        content = "x"
      }
      output "v" { value = var.v }
      output "maps" { value = local.maps }
      output "calls" { value = local.calls }
    `;
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const failed = async (command: string) => {
    try {
      await run('node', [clay, command], { cwd: dir });
    } catch (error) {
      // A run that exits nonzero; anything else, such as node not starting, is rethrown.
      if (error instanceof Error && 'stderr' in error) return error as Error & { code: number; stderr: string };

      throw error;
    }
    throw new Error(`clay ${command} exited 0`);
  };

  it('is planned to a file, applied from it, kept in state, and planned again as no change', async () => {
    await run('node', [clay, 'plan', '--out', 'plan.json'], { cwd: dir });
    await run('node', [clay, 'apply', 'plan.json'], { cwd: dir });
    const { stdout } = await run('node', [clay, 'output', '--json'], { cwd: dir });
    const outputs = JSON.parse(stdout) as Record<string, { value: unknown }>;

    expect(outputs.v.value).toEqual(nestedList(100, 's'));
    expect(outputs.maps.value).toEqual(nestedMap(100));
    expect(outputs.calls.value).toEqual(nestedList(1, 1));
    const replanned = await run('node', [clay, 'plan'], { cwd: dir });
    expect(replanned.stdout).toContain('No changes.');
  });

  it('is refused at the opening one level deeper, however deep the value goes', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), `locals {\n  x = ${deep('[', '1', ']', 20_000)}\n}\n`, 'utf8');

    const refused = await failed('plan');

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Nested more than 100 levels deep\n\n  on main.clay line 2:');
    expect(refused.stderr).toContain(`\n${' '.repeat('  2:   x = '.length + 100)}^`);
  });
});
