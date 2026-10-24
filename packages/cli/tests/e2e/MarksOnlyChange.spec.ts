import { State } from '@clay/contracts';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const clay = path.resolve(__dirname, '../../bin/clay.js');

const DB = 'output "password" {\n  value     = "hunter2"\n  sensitive = true\n}\n';
const MARKED = '"password=${module.db.password}"';
const PLAIN = '"password=hunter2"';

const PLANNED = (note: string) => `  ~ local_file.conf will be updated\n      content: ${note}\n\nPlan: 0 to add, 1 to change, 0 to destroy.`;
const APPLIED = '  ~ local_file.conf updated\n\nApply complete! Resources: 0 added, 1 changed, 0 destroyed.';

const triggers = (first: string, second: string) =>
  `module "db" { source = "./db" }\nresource "null_resource" "n" {\n  triggers = { ${first} = module.db.password, ${second} = module.db.password }\n}\n`;

describe('a change only in which parts of a resource are sensitive', () => {
  let dir: string;

  const clayIn = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
    return stripVTControlCharacters(stdout);
  };

  const written = async (content: string) => {
    const config = `module "db" { source = "./db" }\nresource "local_file" "conf" {\n  path    = "${path.join(dir, 'conf.txt')}"\n  content = ${content}\n}\n`;
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
  };

  const marks = async () => {
    const state = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as State;
    return state.resources['local_file.conf'].sensitive;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-marks-'));
    await fs.mkdir(path.join(dir, 'db'));
    await fs.writeFile(path.join(dir, 'db', 'main.clay'), DB, 'utf8');
    await clayIn('init');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['puts a mark on', PLAIN, MARKED, [['content']], 'will be marked sensitive'],
    ['takes a mark off', MARKED, PLAIN, undefined, 'will no longer be marked sensitive'],
  ])('%s with a plan that updates and an apply that writes it, with no value shown', async (_, before, after, held, note) => {
    await written(before);
    await clayIn('apply', '--yes');
    await written(after);

    const planned = await clayIn('plan');
    const applied = await clayIn('apply', '--yes');

    expect(planned).toContain(PLANNED(note));
    expect(applied).toContain(APPLIED);
    expect(planned + applied).not.toContain('hunter2');
    expect(await marks()).toEqual(held);
    expect(await clayIn('plan')).toContain('No changes.');
  });

  it('plans nothing where the same parts are marked in another order', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), triggers('a', 'b'), 'utf8');
    await clayIn('apply', '--yes');
    await fs.writeFile(path.join(dir, 'main.clay'), triggers('b', 'a'), 'utf8');

    expect(await clayIn('plan')).toContain('No changes.');
  });

  it('shows a move beside the change and counts both', async () => {
    await written(PLAIN);
    await clayIn('apply', '--yes');
    await written(`${MARKED}\n  count   = 1`);

    const planned = await clayIn('plan');
    const applied = await clayIn('apply', '--yes');

    expect(planned).toContain(
      '  ~ local_file.conf[0] will be updated, moved from local_file.conf\n      content: will be marked sensitive\n\nPlan: 0 to add, 1 to change, 0 to destroy, 1 to move.'
    );
    expect(applied).toContain('Resources: 0 added, 1 changed, 0 destroyed, 1 moved.');
  });

  it('applies the change from a saved plan', async () => {
    await written(PLAIN);
    await clayIn('apply', '--yes');
    await written(MARKED);

    await clayIn('plan', '--out', 'tfplan.json');
    const applied = await clayIn('apply', 'tfplan.json');

    expect(applied).toContain(APPLIED);
    expect(await marks()).toEqual([['content']]);
  });
});
