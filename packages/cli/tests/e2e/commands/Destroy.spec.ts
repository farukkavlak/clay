import { exec, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clay } from '../helpers';

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

describe('clay destroy', () => {
  let dir: string;

  const file = (name: string) => path.join(dir, name);
  const configure = (config: string) => fs.writeFile(file('main.clay'), config, 'utf8');
  const exists = (name: string) =>
    fs.access(file(name)).then(
      () => true,
      () => false
    );

  const run = async (...args: string[]): Promise<Ran> => {
    try {
      const { stdout, stderr } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && typeof error.code === 'number')) throw error;

      const { code, stdout, stderr } = error as Error & Ran;
      return { code, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    }
  };

  const ok = async (...args: string[]) => {
    const ran = await run(...args);
    expect(ran.stderr).toBe('');
    expect(ran.code).toBe(0);
    return ran.stdout;
  };

  const pulled = async () => JSON.parse(await ok('state', 'pull')) as { resources: object; outputs: object };

  /** b reads a, and before b goes it prints what a holds and the operation that holds the lock. */
  const chain = () => `
resource "local_file" "a" {
  path    = "${file('a.txt')}"
  content = "from a"
}
resource "local_file" "b" {
  path    = "${file('b.txt')}"
  content = local_file.a.content
  provisioner "local-exec" {
    when    = destroy
    command = "echo seen: $(cat ${file('a.txt')}) $(cat ${file('clay.state.json.lock')})"
  }
}
output "b" { value = local_file.b.path }
`;

  const broken = '\nvariable "unset" {}\nresource "local_file" "c" {\n  bad = 1\n}\n';

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-destroy-')));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('destroys every object, each before what it reads, and clears the outputs', async () => {
    await configure(chain());
    await ok('apply', '-y');

    const printed = await ok('destroy', '-y');

    expect(printed).toMatch(/seen: from a .*"operation": ?"destroy"/u);
    expect(printed.indexOf('local_file.b destroyed')).toBeLessThan(printed.indexOf('local_file.a destroyed'));
    expect(printed).toContain('Destroy complete! Resources: 0 added, 0 changed, 2 destroyed.');
    expect(await exists('a.txt')).toBe(false);
    expect(await exists('b.txt')).toBe(false);
    expect(await pulled()).toMatchObject({ resources: {}, outputs: {} });
  });

  // The same configuration stops a plan.
  it('destroys though the configuration has a variable with no value and an attribute no schema has', async () => {
    await configure(chain());
    await ok('apply', '-y');
    await configure(chain() + broken);
    const planned = await run('plan');
    expect(planned.code).toBe(1);

    await ok('destroy', '-y');

    expect(await exists('a.txt')).toBe(false);
    expect(await pulled()).toMatchObject({ resources: {} });
  });

  // The saved files hold the variable with no value, which a run that read them would stop at.
  it('applies a saved destroy plan made while the configuration has a variable with no value', async () => {
    await configure(chain());
    await ok('apply', '-y');
    await configure(chain() + broken);
    await ok('plan', '--destroy', '--out', 'destroy.plan');

    const printed = await ok('apply', 'destroy.plan');

    expect(printed).toContain('Destroy complete! Resources: 0 added, 0 changed, 2 destroyed');
    expect(await exists('b.txt')).toBe(false);
    expect(await pulled()).toMatchObject({ resources: {} });
  });

  it('destroys the objects inside a module', async () => {
    await fs.mkdir(file('m'));
    await fs.writeFile(file('m/main.clay'), `resource "local_file" "f" {\n  path    = "${file('m.txt')}"\n  content = "m"\n}\n`, 'utf8');
    await configure('module "m" {\n  source = "./m"\n}\n');
    await ok('apply', '-y');

    await ok('destroy', '-y');

    expect(await exists('m.txt')).toBe(false);
    expect(await pulled()).toMatchObject({ resources: {} });
  });

  it('refuses an object applied with prevent_destroy, and destroys nothing', async () => {
    const kept = `resource "local_file" "kept" {\n  path    = "${file('kept.txt')}"\n  content = "k"\n  lifecycle {\n    prevent_destroy = true\n  }\n}\n`;
    await configure(chain() + kept);
    await ok('apply', '-y');

    const refused = await run('destroy', '-y');

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Destroy failed: local_file.kept cannot be deleted: it was applied with prevent_destroy = true');
    expect(await exists('a.txt')).toBe(true);
    expect(await exists('kept.txt')).toBe(true);
  });

  it('exits 1 and destroys nothing when the answer is not yes', async () => {
    await configure(chain());
    await ok('apply', '-y');

    const answered = await promisify(exec)(`echo no | node ${clay} destroy`, { cwd: dir }).catch((error: Ran) => error);

    expect(answered).toMatchObject({ code: 1, stderr: expect.stringContaining('Destroy cancelled.') as unknown });
    expect(await exists('a.txt')).toBe(true);
  });

  it('says the state holds nothing to destroy, and exits 0', async () => {
    await configure(chain());

    const printed = await ok('destroy', '-y');

    expect(printed).toContain('No changes. The state holds nothing to destroy.');
  });
});
