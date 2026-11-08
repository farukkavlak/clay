import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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

  const shell = async (command: string): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await promisify(execFile)('sh', ['-c', command], { cwd: dir });
      return { code: 0, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: stripVTControlCharacters(failed.stdout), stderr: stripVTControlCharacters(failed.stderr) };
    }
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
    await clayOutput(dir, 'init');
    await clayOutput(dir, 'apply', '--yes');
    await write('main.clay', BLOCK + FILE.replace('"x"', '"y"'));
    await clayOutput(dir, 'apply', '--yes');

    expect(await resourcesHere()).toEqual(['local_file.f']);
    expect(await filesKept()).toEqual(['here.json', 'here.json.bak']);
    await expect(fs.access(path.join(dir, 'clay.state.json'))).rejects.toThrow('ENOENT');
  });

  it('is read by plan, output and every state command', async () => {
    await clayOutput(dir, 'init');
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
    await clayOutput(dir, 'init');
    await clayOutput(dir, 'plan', '--out', 'saved.json');
    await write('main.clay', FILE);

    await clayOutput(dir, 'apply', 'saved.json');

    expect(await resourcesHere()).toEqual(['local_file.f']);
    await expect(fs.access(path.join(dir, 'clay.state.json'))).rejects.toThrow('ENOENT');
  });

  it('is named by its own place where a command finds none', async () => {
    await clayOutput(dir, 'init');
    await fs.rm(path.join(dir, 'kept', 'here.json'));

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
    await write('main.clay', 'clay {\n  backend "gcs" {}\n}\n');

    const printed = await refusal(...args);

    expect(printed).toContain(`${start} Clay has no backend "gcs"; it has "local", "http", "s3"`);
    expect(printed).toContain('on main.clay line 2');
    expect(printed).toContain('2:   backend "gcs" {}');
  });

  it('stops a state command at a syntax error in a root file, since the block may be anywhere in them', async () => {
    await clayOutput(dir, 'init');
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

  describe('remembered by init', () => {
    const CHANGED = 'This workspace keeps its state in';

    it.each([
      ['plan', ['plan']],
      ['apply', ['apply', '--yes']],
      ['output', ['output']],
      ['state list', ['state', 'list']],
      ['state show', ['state', 'show', 'local_file.f']],
      ['state mv', ['state', 'mv', 'local_file.f', 'local_file.g']],
      ['state rm', ['state', 'rm', 'local_file.f']],
    ])('refuses %s where init never took the block, at its line', async (_title, args) => {
      const printed = await refusal(...args);

      expect(printed).toContain(`${CHANGED} "clay.state.json" (local), and the configuration names "${path.join('kept', 'here.json')}" (local); run \`clay init\``);
      expect(printed).toContain('on main.clay line 2');
    });

    it('needs no init with no block, and writes no record', async () => {
      await write('main.clay', FILE);

      await clayOutput(dir, 'apply', '--yes');

      expect(await clayOutput(dir, 'state', 'list')).toBe('local_file.f\n');
      await expect(fs.access(path.join(dir, '.clay'))).rejects.toThrow('ENOENT');
    });

    it('takes the same place spelled another way as the same choice', async () => {
      await clayOutput(dir, 'init');
      await write('main.clay', BLOCK.replace('kept/here.json', './kept/../kept/here.json') + FILE);

      expect(await clayOutput(dir, 'plan')).toContain('local_file.f');
    });

    it('lets validate through, since it touches no state', async () => {
      expect(await clayOutput(dir, 'validate')).toContain('Configuration is valid.');
    });

    it('refuses a block taken away after init, with no line to quote', async () => {
      await clayOutput(dir, 'init');
      await write('main.clay', FILE);

      const printed = await refusal('plan');

      expect(printed).toContain(`${CHANGED} "${path.join('kept', 'here.json')}" (local), and the configuration names "clay.state.json" (local)`);
      expect(printed).not.toContain('on main.clay');
    });

    it('refuses a saved plan whose block is not the one init took, and writes nothing', async () => {
      await clayOutput(dir, 'init');
      await clayOutput(dir, 'plan', '--out', 'saved.json');
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'saved.json'), 'utf8')) as { files: Record<string, string> };
      saved.files['main.clay'] = BLOCK.replace('kept/here.json', 'other.json') + FILE;
      await write('saved.json', JSON.stringify(saved));

      const printed = await refusal('apply', 'saved.json');

      expect(printed).toContain(`${CHANGED} "${path.join('kept', 'here.json')}" (local), and the configuration names "other.json" (local)`);
      expect(printed).toContain('on main.clay line 2');
      await expect(fs.access(path.join(dir, 'f.txt'))).rejects.toThrow('ENOENT');
    });

    describe('a block that names another place', () => {
      const QUESTION = `Move the state in "${path.join('kept', 'here.json')}" (local) to "${path.join('kept', 'there.json')}" (local)?`;

      beforeEach(async () => {
        await clayOutput(dir, 'init');
        await clayOutput(dir, 'apply', '--yes');
        await write('main.clay', BLOCK.replace('here.json', 'there.json') + FILE);
      });

      it('has its state moved there by init once the answer is yes, and the old one kept', async () => {
        const { code, stdout } = await shell(`echo yes | node ${clay} init`);

        expect(code).toBe(0);
        expect(stdout).toContain(QUESTION);
        expect(stdout).toContain(`Moved the state in "${path.join('kept', 'here.json')}" to "${path.join('kept', 'there.json')}"; the old one is left as it was`);
        expect(await filesKept()).toEqual(['here.json', 'here.json.bak', 'there.json']);
        expect(await clayOutput(dir, 'plan')).toContain('No changes');
        expect(await clayOutput(dir, 'state', 'list')).toBe('local_file.f\n');
      });

      it('has its state moved without a question by init --yes', async () => {
        const stdout = await clayOutput(dir, 'init', '--yes');

        expect(stdout).not.toContain(QUESTION);
        expect(await clayOutput(dir, 'state', 'list')).toBe('local_file.f\n');
      });

      it('changes nothing and exits 1 when the answer is no', async () => {
        const { code, stderr } = await shell(`echo no | node ${clay} init`);

        expect(code).toBe(1);
        expect(stderr).toContain('The state was not moved, and nothing changed');
        expect(await filesKept()).toEqual(['here.json', 'here.json.bak']);
        expect(await refusal('plan')).toContain(CHANGED);
      });

      it('releases both locks and changes nothing on Ctrl-C at the question', async () => {
        const child = spawn('node', [clay, 'init'], { cwd: dir });
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        const ended = once(child, 'exit');
        while (!stdout.includes(QUESTION)) await sleep(20);
        expect(await filesKept()).toEqual(['here.json', 'here.json.bak', 'here.json.lock', 'there.json.lock']);

        child.kill('SIGINT');

        const [code] = await ended;
        expect(code).toBe(130);
        expect(await filesKept()).toEqual(['here.json', 'here.json.bak']);
        expect(await refusal('plan')).toContain(CHANGED);
      });

      it('takes the new place as it is, without asking, where an init stopped after the copy', async () => {
        await fs.copyFile(path.join(dir, 'kept', 'here.json'), path.join(dir, 'kept', 'there.json'));

        const { code, stdout } = await shell(`node ${clay} init < /dev/null`);

        expect(code).toBe(0);
        expect(stdout).toContain(`Took "${path.join('kept', 'there.json')}", which holds the same state as "${path.join('kept', 'here.json')}"`);
        expect(await clayOutput(dir, 'state', 'list')).toBe('local_file.f\n');
      });

      it('names --yes and changes nothing when the input is closed', async () => {
        const { code, stderr } = await shell(`node ${clay} init < /dev/null`);

        expect(code).toBe(1);
        expect(stderr).toContain('No answer: the input is closed. Run with --yes to approve without asking');
        expect(await filesKept()).toEqual(['here.json', 'here.json.bak']);
      });
    });

    it('moves the default state when a block is added', async () => {
      await write('main.clay', FILE);
      await clayOutput(dir, 'init');
      await clayOutput(dir, 'apply', '--yes');
      await write('main.clay', BLOCK + FILE);

      await clayOutput(dir, 'init', '--yes');

      expect(await resourcesHere()).toEqual(['local_file.f']);
      expect(await clayOutput(dir, 'plan')).toContain('No changes');
    });

    it('goes back to the default place when the block is taken away and nothing is left behind', async () => {
      await clayOutput(dir, 'init');
      await fs.rm(path.join(dir, 'kept', 'here.json'));
      await write('main.clay', FILE);

      await clayOutput(dir, 'init');

      expect(await clayOutput(dir, 'plan')).toContain('local_file.f');
      await expect(fs.access(path.join(dir, 'clay.state.json'))).resolves.toBeUndefined();
    });

    it('refuses a directory that does not exist and makes none', async () => {
      await write('main.clay', BLOCK.replace('kept/here.json', 'nowhere/here.json') + FILE);

      expect(await refusal('init')).toContain(`${path.sep}nowhere is not a directory`);
      await expect(fs.access(path.join(dir, 'nowhere'))).rejects.toThrow('ENOENT');
      await expect(fs.access(path.join(dir, '.clay'))).rejects.toThrow('ENOENT');
    });

    it('refuses a path that is a directory', async () => {
      await write('main.clay', BLOCK.replace('kept/here.json', 'kept') + FILE);

      expect(await refusal('init')).toContain('kept is a directory, and the state is a file');
      await expect(fs.access(path.join(dir, '.clay'))).rejects.toThrow('ENOENT');
    });

    it('refuses a parent that is a file', async () => {
      await write('plain', 'x');
      await write('main.clay', BLOCK.replace('kept/here.json', 'plain/here.json') + FILE);

      expect(await refusal('init')).toContain('plain is not a directory');
    });

    it.each([
      ['no JSON', 'nope'],
      ['no object', 'null'],
      ['a type Clay does not have', '{"type":"s3","settings":{}}'],
      ['no settings', '{"type":"local"}'],
      ['a setting the backend does not take', '{"type":"local","settings":{"path":"s.json","mode":"x"}}'],
    ])('refuses a record holding %s, in init too', async (_title, record) => {
      await fs.mkdir(path.join(dir, '.clay'));
      await write('.clay/backend.json', record);

      for (const command of ['plan', 'init']) expect(await refusal(command)).toContain(`backend.json is not what \`clay init\` writes; remove it and run \`clay init\``);
    });

    it('stays with the workspace when it moves', async () => {
      await clayOutput(dir, 'init');
      await clayOutput(dir, 'apply', '--yes');
      const moved = `${dir}-moved`;
      await fs.rename(dir, moved);

      try {
        expect(await clayOutput(moved, 'state', 'list')).toBe('local_file.f\n');
      } finally {
        await fs.rm(moved, { recursive: true, force: true });
      }
    });
  });
});
