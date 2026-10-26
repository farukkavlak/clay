import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clay, clayOutput } from '../helpers';

describe('depends_on', () => {
  let dir: string;

  const clayIn = (...args: string[]) => clayOutput(dir, ...args);

  const failedIn = async (...args: string[]) => {
    try {
      await promisify(execFile)('node', [clay, ...args], { cwd: dir });
    } catch (error) {
      const { code, stderr } = error as { code: number; stderr: string };
      return { code, stderr: stripVTControlCharacters(stderr) };
    }
    throw new Error(`clay ${args.join(' ')} exited 0`);
  };

  const file = (name: string) => path.join(dir, name);
  const write = (config: string) => fs.writeFile(file('main.clay'), config, 'utf8');
  const writeModule = async (config: string, name = 'm') => {
    await fs.mkdir(file(name), { recursive: true });
    await fs.writeFile(file(`${name}/main.clay`), config, 'utf8');
  };
  const state = async () => JSON.parse(await fs.readFile(file('clay.state.json'), 'utf8'));

  const fileA = () => `resource "local_file" "a" {\n  path    = "${file('a.txt')}"\n  content = "from a"\n}\n`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-depends-on-'));
    await clayIn('init');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads a data source after the file it waits for is made, and at plan once the file stays as it is', async () => {
    await write(
      `${fileA()}data "local_file" "d" {\n  path       = "${file('a.txt')}"\n  depends_on = [local_file.a]\n}\nresource "local_file" "b" {\n  path    = "${file('b.txt')}"\n  content = data.local_file.d.content\n}\n`
    );

    expect(await clayIn('plan')).toContain('  <= data.local_file.d will be read during apply\n');
    await clayIn('apply', '--yes');

    expect(await fs.readFile(file('b.txt'), 'utf8')).toBe('from a');
    const again = await clayIn('plan');
    expect(again).not.toContain('data.local_file.d');
    expect(again).toContain('No changes.');
  });

  it('keeps what a resource waits for through a local in state, and destroys the waiting one first', async () => {
    await write(
      `${fileA()}locals {\n  l = local_file.a.path\n}\nresource "local_file" "b" {\n  path       = "${file('b.txt')}"\n  content    = "from b"\n  depends_on = [local.l]\n}\n`
    );
    await clayIn('apply', '--yes');

    const { resources } = await state();
    expect(resources['local_file.b'].dependencies).toEqual(['local_file.a']);

    await write('');
    expect(await clayIn('apply', '--yes')).toContain('  - local_file.b destroyed\n  - local_file.a destroyed\n');
  });

  it('waits for every instance of a resource with count', async () => {
    await write(
      `resource "local_file" "a" {\n  count   = 2\n  path    = "${dir}/a\${count.index}.txt"\n  content = "a"\n}\nresource "local_file" "b" {\n  path       = "${file('b.txt')}"\n  content    = "b"\n  depends_on = [local_file.a]\n}\n`
    );
    await clayIn('apply', '--yes');

    const { resources } = await state();
    expect(resources['local_file.b'].dependencies).toEqual(['local_file.a[0]', 'local_file.a[1]']);
  });

  it('refuses one instance, where it is written', async () => {
    await write(`${fileA()}resource "local_file" "b" {\n  path       = "${file('b.txt')}"\n  content    = "b"\n  depends_on = [local_file.a[0]]\n}\n`);

    const { code, stderr } = await failedIn('plan');

    expect(code).toBe(1);
    expect(stderr).toContain('depends_on waits for a whole object: write local_file.a, not local_file.a[0]\n\n  on main.clay line 8:\n\n  8:   depends_on = [local_file.a[0]]\n');
  });

  it('refuses what the configuration does not declare, where it is written', async () => {
    await write(`data "local_file" "d" {\n  path       = "${file('a.txt')}"\n  depends_on = [local_file.typo]\n}\n`);

    const { code, stderr } = await failedIn('plan');

    expect(code).toBe(1);
    expect(stderr).toContain('"local_file.typo" is not declared in the configuration\n\n  on main.clay line 3, in data "local_file" "d":\n');
  });

  it('refuses a cycle it closes, at the line that closes it', async () => {
    await write(
      `resource "local_file" "a" {\n  path       = "${file('a.txt')}"\n  content    = "a"\n  depends_on = [local_file.b]\n}\nresource "local_file" "b" {\n  path       = "${file('b.txt')}"\n  content    = "b"\n  depends_on = [local_file.a]\n}\n`
    );

    const { code, stderr } = await failedIn('plan');

    expect(code).toBe(1);
    expect(stderr).toContain('Dependency cycle detected: local_file.a -> local_file.b -> local_file.a\n\n  on main.clay line 4, in resource "local_file" "a":\n');
  });

  it('makes every block of a module wait for what its call waits for', async () => {
    await writeModule(
      `data "local_file" "d" {\n  path = "${file('a.txt')}"\n}\nresource "local_file" "inner" {\n  path    = "${file('inner.txt')}"\n  content = data.local_file.d.content\n}\n`
    );
    await write(`${fileA()}module "m" {\n  source     = "./m"\n  depends_on = [local_file.a]\n}\n`);

    expect(await clayIn('plan')).toContain('  <= module.m.data.local_file.d will be read during apply\n');
    await clayIn('apply', '--yes');

    expect(await fs.readFile(file('inner.txt'), 'utf8')).toBe('from a');
    const { resources } = await state();
    expect(resources['module.m.local_file.inner'].dependencies).toEqual(['local_file.a']);
    expect(await clayIn('plan')).toContain('No changes.');
  });

  it('waits for every block of a whole module, one no output reads among them, and destroys the waiting one first', async () => {
    await writeModule(`resource "local_file" "inner" {\n  path    = "${file('inner.txt')}"\n  content = "inner"\n}\n`);
    await write(`module "m" {\n  source = "./m"\n}\nresource "local_file" "b" {\n  path       = "${file('b.txt')}"\n  content    = "b"\n  depends_on = [module.m]\n}\n`);
    await clayIn('apply', '--yes');

    const { resources } = await state();
    expect(resources['local_file.b'].dependencies).toEqual(['module.m.local_file.inner']);

    await write('');
    expect(await clayIn('apply', '--yes')).toContain('  - local_file.b destroyed\n  - module.m.local_file.inner destroyed\n');
  });

  it('waits for every block of the modules a whole module calls', async () => {
    await writeModule(`resource "local_file" "x" {\n  path    = "${file('x.txt')}"\n  content = "x"\n}\n`, 'n');
    await writeModule('module "n" {\n  source = "../n"\n}\n');
    await write(`module "m" {\n  source = "./m"\n}\nresource "local_file" "b" {\n  path       = "${file('b.txt')}"\n  content    = "b"\n  depends_on = [module.m]\n}\n`);
    await clayIn('apply', '--yes');

    const { resources } = await state();
    expect(resources['local_file.b'].dependencies).toEqual(['module.m.module.n.local_file.x']);

    await write('');
    expect(await clayIn('apply', '--yes')).toContain('  - local_file.b destroyed\n  - module.m.module.n.local_file.x destroyed\n');
  });

  it.each([
    ['count', 'count  = 2\n  i      = count.index', ['module.m[0].local_file.inner', 'module.m[1].local_file.inner']],
    ['for_each', 'for_each = toset(["p", "q"])\n  i        = each.key', ['module.m["p"].local_file.inner', 'module.m["q"].local_file.inner']],
  ])('waits for an output of a module with %s, with no index, and not for what the output does not read', async (_, repetition, dependencies) => {
    await writeModule(
      `variable "i" {}\nresource "local_file" "inner" {\n  path    = "${dir}/inner\${var.i}.txt"\n  content = "inner"\n}\nresource "local_file" "other" {\n  path    = "${dir}/other\${var.i}.txt"\n  content = "other"\n}\noutput "o" {\n  value = local_file.inner.path\n}\n`
    );
    await write(
      `module "m" {\n  source = "./m"\n  ${repetition}\n}\nresource "local_file" "c" {\n  path       = "${file('c.txt')}"\n  content    = "c"\n  depends_on = [module.m.o]\n}\n`
    );
    await clayIn('apply', '--yes');

    const { resources } = await state();
    expect(resources['local_file.c'].dependencies).toEqual(dependencies);
  });

  it('makes what reads an output wait for what the output waits for', async () => {
    await writeModule(
      `resource "local_file" "inner" {\n  path    = "${file('inner.txt')}"\n  content = "inner"\n}\noutput "o" {\n  value      = "o"\n  depends_on = [local_file.inner]\n}\n`
    );
    await write(`module "m" {\n  source = "./m"\n}\nresource "local_file" "c" {\n  path    = "${file('c.txt')}"\n  content = module.m.o\n}\n`);
    await clayIn('apply', '--yes');

    const { resources } = await state();
    expect(resources['local_file.c'].dependencies).toEqual(['module.m.local_file.inner']);
  });

  it('refuses a module call that waits for its own module, at the line that says it', async () => {
    await writeModule('output "o" {\n  value = "o"\n}\n');
    await write(`module "m" {\n  source     = "./m"\n  depends_on = [module.m]\n}\n`);

    const { code, stderr } = await failedIn('plan');

    expect(code).toBe(1);
    expect(stderr).toContain('Dependency cycle detected: module.m -> module.m\n\n  on main.clay line 3, in module "m":\n');
  });

  it('refuses an output the module does not have, where it is written', async () => {
    await writeModule('output "o" {\n  value = "o"\n}\n');
    await write(`module "m" {\n  source = "./m"\n}\noutput "x" {\n  value      = 1\n  depends_on = [module.m.typo]\n}\n`);

    const { code, stderr } = await failedIn('plan');

    expect(code).toBe(1);
    expect(stderr).toContain('module "m" has no output "typo"\n\n  on main.clay line 6, in output "x":\n');
  });
});
