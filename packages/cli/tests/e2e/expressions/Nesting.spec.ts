import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const clay = path.resolve(__dirname, '../../../bin/clay.js');

const failed = async (command: string[], cwd: string) => {
  try {
    await run('node', [clay, ...command], { cwd });
  } catch (error) {
    // A run that exits nonzero; anything else, such as node not starting, is rethrown.
    if (error instanceof Error && 'stderr' in error) return error as Error & { code: number; stderr: string };

    throw error;
  }
  throw new Error(`clay ${command.join(' ')} exited 0`);
};

const deep = (open: string, inner: string, close: string, levels: number) => open.repeat(levels) + inner + close.repeat(levels);

function nestedMap(levels: number, inner: unknown): unknown {
  let value = inner;
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
      variable "o" {
        type    = ${deep('object({a=', 'string', '})', 100)}
        default = ${deep('{a=', '"s"', '}', 100)}
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
      output "o" { value = var.o }
      output "maps" { value = local.maps }
      output "calls" { value = local.calls }
    `;
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is planned to a file, applied from it, kept in state, and planned again as no change', async () => {
    await run('node', [clay, 'plan', '--out', 'plan.json'], { cwd: dir });
    await run('node', [clay, 'apply', 'plan.json'], { cwd: dir });
    const { stdout } = await run('node', [clay, 'output', '--json'], { cwd: dir });
    const outputs = JSON.parse(stdout) as Record<string, { value: unknown }>;

    expect(outputs.v.value).toEqual(nestedList(100, 's'));
    expect(outputs.o.value).toEqual(nestedMap(100, 's'));
    expect(outputs.maps.value).toEqual(nestedMap(100, 1));
    expect(outputs.calls.value).toEqual(nestedList(1, 1));
    const replanned = await run('node', [clay, 'plan'], { cwd: dir });
    expect(replanned.stdout).toContain('No changes.');
  });

  it('is refused at the opening one level deeper, however deep the value goes', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), `locals {\n  x = ${deep('[', '1', ']', 20_000)}\n}\n`, 'utf8');

    const refused = await failed(['plan'], dir);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Nested more than 100 levels deep\n\n  on main.clay line 2:');
    expect(refused.stderr).toContain(`\n${' '.repeat('  2:   x = '.length + 100)}^`);
  });
});

// Each local wraps the one before it in a list, so the value grows a level with each.
const chain = (links: number) => {
  const wrapping = Array.from({ length: links }, (_, step) => `  l${step + 1} = [local.l${step}]`);
  return `locals {\n  l0 = "s"\n${wrapping.join('\n')}\n}\noutput "last" { value = local.l${links} }\n`;
};

describe('a value worked out deeper than the parser takes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-nesting-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is planned, applied and planned again as no change at the deepest the parser takes', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), chain(100), 'utf8');

    await run('node', [clay, 'apply', '--yes'], { cwd: dir });
    const { stdout } = await run('node', [clay, 'output', '--json'], { cwd: dir });
    const replanned = await run('node', [clay, 'plan'], { cwd: dir });

    expect((JSON.parse(stdout) as Record<string, { value: unknown }>).last.value).toEqual(nestedList(100, 's'));
    expect(replanned.stdout).toContain('No changes.');
  });

  it.each([['validate'], ['plan'], ['apply', '--yes']])('is refused by %s at the local one level deeper, before anything is written', async (...command) => {
    await fs.writeFile(path.join(dir, 'main.clay'), chain(6000), 'utf8');

    const refused = await failed(command, dir);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Nested more than 100 levels deep\n\n  on main.clay line 103, in local "l101":');
    expect(refused.stderr).toContain(`\n${' '.repeat('  103:   l101 = '.length)}^`);
    await expect(fs.access(path.join(dir, 'clay.state.json'))).rejects.toThrow('ENOENT');
  });

  // Read as written, the variable is unknown of its type, so only the type is 101 levels deep.
  it('is refused where only its type is that deep', async () => {
    const config = `variable "v" {\n  type    = ${deep('list(', 'string', ')', 100)}\n  default = ${deep('[', '"s"', ']', 100)}\n}\nresource "local_file" "f" {\n  count   = 0\n  path    = "x"\n  content = [var.v]\n}\n`;
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');

    const refused = await failed(['validate'], dir);

    expect(refused.stderr).toContain('Nested more than 100 levels deep\n\n  on main.clay line 8, in resource "local_file" "f":');
  });
});
