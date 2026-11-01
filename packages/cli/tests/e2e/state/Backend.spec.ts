import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clay, clayOutput } from '../helpers';

const BLOCK = 'clay {\n  backend "local" {\n    path = "kept/here.json"\n  }\n}\n';
const FILE = 'resource "local_file" "f" {\n  path    = "f.txt"\n  content = "x"\n}\noutput "o" {\n  value = local_file.f.content\n}\n';

describe('a state kept where a backend block says', () => {
  let dir: string;

  const refusal = async (...args: string[]): Promise<string> => {
    try {
      await promisify(execFile)('node', [clay, ...args], { cwd: dir });
    } catch (error) {
      return stripVTControlCharacters((error as { stderr: string }).stderr);
    }

    throw new Error('Expected the command to fail');
  };

  const write = (name: string, content: string) => fs.writeFile(path.join(dir, name), content, 'utf8');
  const stateHere = () => fs.readFile(path.join(dir, 'kept', 'here.json'), 'utf8').then((text) => JSON.parse(text) as { resources: Record<string, unknown> });
  const resourcesHere = () => stateHere().then(({ resources }) => Object.keys(resources));
  const filesKept = () => fs.readdir(path.join(dir, 'kept')).then((names) => names.sort());

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-backend-'));
    await fs.mkdir(path.join(dir, 'kept'));
    await write('main.clay', BLOCK + FILE);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is started there by init', async () => {
    await clayOutput(dir, 'init');

    expect(await stateHere()).toMatchObject({ resources: {} });
    await expect(fs.access(path.join(dir, 'clay.state.json'))).rejects.toThrow('ENOENT');
  });

  it('is written there by apply, with its backup and no file at the old place', async () => {
    await clayOutput(dir, 'apply', '--yes');
    await write('main.clay', BLOCK + FILE.replace('"x"', '"y"'));
    await clayOutput(dir, 'apply', '--yes');

    expect(await resourcesHere()).toEqual(['local_file.f']);
    expect(await filesKept()).toEqual(['here.json', 'here.json.bak']);
    await expect(fs.access(path.join(dir, 'clay.state.json'))).rejects.toThrow('ENOENT');
  });

  it('is read by plan, output and every state command', async () => {
    await clayOutput(dir, 'apply', '--yes');

    expect(await clayOutput(dir, 'plan')).toContain('No changes');
    expect(await clayOutput(dir, 'output')).toContain('o = "x"');
    expect(await clayOutput(dir, 'state', 'list')).toBe('local_file.f\n');
    expect(await clayOutput(dir, 'state', 'show', 'local_file.f')).toContain('content = "x"');

    await clayOutput(dir, 'state', 'mv', 'local_file.f', 'local_file.g');
    expect(await resourcesHere()).toEqual(['local_file.g']);

    await clayOutput(dir, 'state', 'rm', 'local_file.g');
    expect(await resourcesHere()).toEqual([]);
  });

  it('is written where the saved plan says, though the block has changed on disk since', async () => {
    await clayOutput(dir, 'plan', '--out', 'saved.json');
    await write('main.clay', FILE);

    await clayOutput(dir, 'apply', 'saved.json');

    expect(await resourcesHere()).toEqual(['local_file.f']);
    await expect(fs.access(path.join(dir, 'clay.state.json'))).rejects.toThrow('ENOENT');
  });

  it('is named by its own place where a command finds none', async () => {
    expect(await clayOutput(dir, 'output')).toContain(path.join('kept', 'here.json'));
    expect(await clayOutput(dir, 'state', 'list')).toContain(path.join('kept', 'here.json'));
  });

  it.each([
    ['init', ['init'], 'Failed to initialize workspace:'],
    ['plan', ['plan'], 'Planning failed:'],
    ['validate', ['validate'], 'Validation failed:'],
    ['apply', ['apply', '--yes'], 'Apply failed:'],
    ['output', ['output'], 'Error reading outputs:'],
    ['state list', ['state', 'list'], 'Error listing state:'],
    ['state show', ['state', 'show', 'local_file.f'], 'Error showing resource:'],
    ['state mv', ['state', 'mv', 'local_file.f', 'local_file.g'], 'Error moving resource:'],
    ['state rm', ['state', 'rm', 'local_file.f'], 'Error removing resource:'],
  ])('refuses a backend Clay does not have in %s, quoting its line', async (_title, args, start) => {
    await write('main.clay', 'clay {\n  backend "s3" {}\n}\n');

    const printed = await refusal(...args);

    expect(printed).toContain(`${start} Clay has no backend "s3"; it has "local"`);
    expect(printed).toContain('on main.clay line 2');
    expect(printed).toContain('2:   backend "s3" {}');
  });

  it('stops a state command at a syntax error in a root file, since the block may be anywhere in them', async () => {
    await clayOutput(dir, 'apply', '--yes');
    await write('other.clay', 'resource {}\n');

    expect(await refusal('state', 'list')).toContain('on other.clay line 1');
  });

  it('refuses a backend in a module, where it is written', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await write('m/main.clay', 'clay {\n  backend "local" {}\n}\n');
    await write('main.clay', 'module "m" {\n  source = "./m"\n}\n');

    const printed = await refusal('validate');

    expect(printed).toContain(`module "m" names a backend, which only the root configuration can: a module keeps its state with its caller's`);
    expect(printed).toContain('on m/main.clay line 2');
  });

  it('keeps the default place with a backend block that names none', async () => {
    await write('main.clay', `clay {\n  backend "local" {}\n}\n${FILE}`);

    await clayOutput(dir, 'apply', '--yes');

    await expect(fs.access(path.join(dir, 'clay.state.json'))).resolves.toBeUndefined();
  });
});
