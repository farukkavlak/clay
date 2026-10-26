import { STATE_VERSION } from '@clay/contracts';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clay } from '../helpers';

const ESCAPE = '\u001B';
const CLEAR = `${ESCAPE}[2J`;

const fails = (name: string) => `resource "command_exec" "${name}" { command = "printf '\\\\033[2J' >&2; false" }\n`;

// Colour is off where stderr is no terminal, so any escape left is one the text brought.
describe('a control character in what the CLI prints', () => {
  let dir: string;

  const failing = async (...args: string[]) => {
    const failure = await promisify(execFile)('node', [clay, ...args], { cwd: dir }).catch((error: { code: number; stderr: string }) => error);
    if (!('code' in failure)) throw new Error(`clay ${args.join(' ')} did not fail`);
    return failure.stderr;
  };

  const written = async (config: string) => fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');

  beforeEach(async () => {
    // Every message that names a path in it carries an escape.
    dir = await fs.mkdtemp(path.join(os.tmpdir(), `clay-control-${ESCAPE}-`));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['a carriage return in the source line', 'resource "null_resource" "n" {\n  triggers = { a = "xx\rYY" } bad = 1\n}\n', '{ a = "xx\u240DYY" } bad = 1'],
    ['an escape in a comment on the source line', `resource "null_resource" "n" { bad = 1 } # ${CLEAR}\n`, `# \u241B[2J`],
    ['an escape the lexer refuses', `resource "null_resource" "n" {}\n${ESCAPE}\n`, 'Unexpected character: "\u241B"'],
    ['an escape in a module path', `module "m" { source = "./${ESCAPE}x" }\n`, '\u241Bx'],
  ])('shows %s as a character of its own', async (_, config, shown) => {
    await written(config);

    const printed = await failing('plan');

    expect(printed).toContain(shown);
    expect(printed).not.toContain('\r');
    expect(printed).not.toContain(ESCAPE);
  });

  it('shows an escape in what a failed command printed as a character of its own', async () => {
    await written(fails('c'));

    const printed = await failing('apply', '--yes');

    expect(printed).toContain('\u241B[2J');
    expect(printed).not.toContain(ESCAPE);
  });

  it('shows an escape in what several failed commands printed as a character of its own', async () => {
    await written(fails('a') + fails('b'));

    const printed = await failing('apply', '--yes');

    expect(printed).toContain('Failed: command_exec.a');
    expect(printed).toContain('\u241B[2J');
    expect(printed).not.toContain(ESCAPE);
  });

  it.skipIf(process.getuid?.() === 0)('shows an escape in the path of a state that cannot be saved as a character of its own', async () => {
    const journal = path.join(dir, 'clay.state.json.journal');
    await written(`resource "command_exec" "c" { command = "touch '${journal}' && chmod 444 '${journal}'; exit 1" }\n`);

    const printed = await failing('apply', '--yes');

    expect(printed).toContain('The state could not be saved: EACCES');
    expect(printed).toContain('\u241B');
    expect(printed).not.toContain(ESCAPE);
  });

  it.each([
    ['output', ['output']],
    ['state list', ['state', 'list']],
  ])('shows an escape in the path of a broken state as a character of its own, in %s', async (_, args) => {
    await fs.writeFile(path.join(dir, 'clay.state.json'), '{broken', 'utf8');

    const printed = await failing(...args);

    expect(printed).toContain('\u241B');
    expect(printed).not.toContain(ESCAPE);
  });

  // Root writes where the mode says it cannot.
  it.skipIf(process.getuid?.() === 0)('shows an escape in the path of a workspace it cannot write as a character of its own', async () => {
    await fs.chmod(dir, 0o555);

    const printed = await failing('init').finally(() => fs.chmod(dir, 0o755));

    expect(printed).toContain('Failed to initialize workspace');
    expect(printed).toContain('\u241B');
    expect(printed).not.toContain(ESCAPE);
  });

  it('refuses a direction override written raw in an address, shows it as a character of its own and says how to write it', async () => {
    await written('resource "null_resource" "n" {}\n');

    const printed = await failing('state', 'show', 'null_resource.n["a\u202Eb"]');

    expect(printed).toContain('null_resource.n["a\uFFFDb"]');
    expect(printed).toContain(String.raw`a key is written as ["a\u202eb"]`);
    expect(printed).not.toContain('\u202E');
  });

  it.each([
    ['an unknown command', [`pl${CLEAR}an`]],
    ['an unknown option', ['plan', `--x${CLEAR}`]],
    ['an option value it refuses', ['apply', '--parallelism', CLEAR]],
    ['an unknown option of a state command', ['state', 'list', `--x${CLEAR}`]],
  ])('shows an escape in %s as a character of its own', async (_, args) => {
    const printed = await failing(...args);

    expect(printed).toContain('\u241B[2J');
    expect(printed).not.toContain(ESCAPE);
  });

  it.each([
    ['state show', ['show', `null_resource.${CLEAR}`]],
    ['state rm', ['rm', `null_resource.${CLEAR}`]],
    ['state mv', ['mv', `null_resource.${CLEAR}`, 'null_resource.m']],
  ])('shows an escape in an address from the command line as a character of its own, in %s', async (_, args) => {
    await written('resource "null_resource" "n" {}\n');

    const printed = await failing('state', ...args);

    expect(printed).toContain('\u241B[2J');
    expect(printed).not.toContain(ESCAPE);
  });
});

// Escaped as JSON escapes the rest, so a value reads back whole and the terminal is left alone.
const RAW = ['\u007F', '\u0085', '\u202E'];
const KEY = String.raw`a\u007F\u0085\u202Eb`;
const SHOWN = String.raw`a\u007f\u0085\u202eb`;

describe('a control character in what the CLI prints to stdout', () => {
  let dir: string;

  const succeeding = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
    return stdout;
  };

  const expectEscaped = (printed: string) => {
    expect(printed).toContain(SHOWN);
    for (const raw of RAW) expect(printed).not.toContain(raw);
    expect(printed).not.toContain(ESCAPE);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), `clay-control-${ESCAPE}-`));
    const config = `
      resource "null_resource" "n" {
        for_each = { "${KEY}" = "${KEY}" }
        triggers = { "${KEY}" = each.value }
      }
      output "o" { value = { "${KEY}" = "${KEY}" } }
    `;
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('escapes them in a plan', async () => {
    expectEscaped(await succeeding('plan'));
  });

  it('escapes them in an apply', async () => {
    expectEscaped(await succeeding('apply', '--yes'));
  });

  it.each([
    ['state list', ['state', 'list']],
    ['state show', ['state', 'show', `null_resource.n["${SHOWN}"]`]],
    ['output', ['output']],
  ])('escapes them in %s', async (_, args) => {
    await succeeding('apply', '--yes');

    expectEscaped(await succeeding(...args));
  });

  it('quotes an attribute name with a control character in it, in state show', async () => {
    const resource = { resourceType: 'null_resource', name: 'm', attributes: { ['x\u007F']: 'v' } };
    await fs.writeFile(path.join(dir, 'clay.state.json'), JSON.stringify({ version: STATE_VERSION, serial: 0, resources: { 'null_resource.m': resource } }), 'utf8');

    const printed = await succeeding('state', 'show', 'null_resource.m');

    expect(printed).toContain(String.raw`  "x\u007f" = "v"`);
    expect(printed).not.toContain('\u007F');
  });

  it('escapes them in output --json, which still reads back as the value', async () => {
    await succeeding('apply', '--yes');

    const printed = await succeeding('output', '--json');

    expectEscaped(printed);
    const key = `a${RAW.join('')}b`;
    expect(JSON.parse(printed)).toMatchObject({ o: { value: { [key]: key } } });
  });

  it.each([
    ['output', ['output']],
    ['state list', ['state', 'list']],
  ])('shows an escape in the path of a state it cannot find as a character of its own, in %s', async (_, args) => {
    const printed = await succeeding(...args);

    expect(printed).toContain('No state file found at');
    expect(printed).toContain('\u241B');
    expect(printed).not.toContain(ESCAPE);
  });

  it('shows an escape in the path a plan is saved to as a character of its own', async () => {
    const printed = await succeeding('plan', '--out', path.join(dir, 'plan.json'));

    expect(printed).toContain('Plan saved to');
    expect(printed).toContain('\u241B');
    expect(printed).not.toContain(ESCAPE);
  });
});
