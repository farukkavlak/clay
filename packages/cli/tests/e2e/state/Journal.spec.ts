import { Address } from '@clay/contracts';
import { LocalBackend } from '@clay/state';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clay, clayOutput, orchestratorIn } from '../helpers';
import { start } from '../start';

const THREE = 'resource "null_resource" "a" {\n  count = 3\n}\n';

/** x reads nothing, or what `dependsOn` adds, which changes no value. */
const quiet = (dependsOn: string) => `resource "null_resource" "x" {\n${dependsOn}}\nresource "null_resource" "y" {}\n`;

/** Runs once the three exist, as the last action of the run. */
const after = (command: string) => `${THREE}resource "command_exec" "last" {\n  command = "${command} # \${null_resource.a[2].id}"\n}\n`;

describe('the state of a run', () => {
  let dir: string;

  const configure = (config: string) => fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
  const held = async () => {
    const listed = await clayOutput(dir, 'state', 'list');
    return listed.trim().split('\n');
  };
  const beside = () => fs.readdir(dir);
  const writtenKeys = async (file = 'clay.state.json') => {
    const written = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as { resources: object };
    return Object.keys(written.resources);
  };
  /** An apply that kills clay with no chance to save, in a command whose shell is a child of clay. */
  const killedApply = () => expect(promisify(execFile)('node', [clay, 'apply', '-y'], { cwd: dir })).rejects.toMatchObject({ signal: 'SIGKILL' });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-journal-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps what a run made before it was killed', async () => {
    await configure(after('kill -9 $PPID'));

    await killedApply();

    expect(await held()).toEqual(['null_resource.a[0]', 'null_resource.a[1]', 'null_resource.a[2]']);
  });

  it('keeps a move made before it was killed, which no action records', async () => {
    await configure('resource "null_resource" "a" {\n  triggers = { v = "1" }\n}\n');
    await clayOutput(dir, 'apply', '-y');
    const moved = 'moved {\n  from = null_resource.a\n  to   = null_resource.b\n}\n';
    const changed = 'resource "null_resource" "b" {\n  triggers = { v = "2" }\n}\n';
    const kill = 'resource "command_exec" "last" {\n  command = "kill -9 $PPID # ${null_resource.b.id}"\n}\n';
    await configure(moved + changed + kill);

    await killedApply();

    expect(await held()).toEqual(['null_resource.b']);
  });

  it('keeps what a no-op saved before it was killed', async () => {
    await configure(quiet(''));
    await clayOutput(dir, 'apply', '-y');
    const kill = 'resource "command_exec" "last" {\n  command = "kill -9 $PPID # ${null_resource.x.id}"\n}\n';
    await configure(quiet('  depends_on = [null_resource.y]\n') + kill);

    await killedApply();

    const read = await new LocalBackend(dir).read();
    expect(read.resources['null_resource.x'].dependencies).toEqual(['null_resource.y']);
  });

  it('refuses a plan made while it ran, once it was killed after more actions', async () => {
    const planning = `resource "command_exec" "plan" {\n  command = "node ${clay} plan --out mid.plan # \${null_resource.a[2].id}"\n  cwd = "${dir}"\n}\n`;
    const more = 'resource "null_resource" "c" {\n  depends_on = [command_exec.plan]\n}\n';
    const kill = 'resource "command_exec" "last" {\n  command = "kill -9 $PPID # ${null_resource.c.id}"\n}\n';
    await configure(THREE + planning + more + kill);
    await killedApply();
    await fs.rm(path.join(dir, 'clay.state.json.lock'));

    await expect(clayOutput(dir, 'apply', 'mid.plan')).rejects.toMatchObject({ stderr: expect.stringContaining('The state has changed since the plan was made. Plan again.') });

    expect(await held()).toContain('null_resource.c');
  });

  it('is written whole by the next run that changes something, after one that was killed', async () => {
    await configure(after('kill -9 $PPID'));
    await killedApply();

    // As its message says to, since a killed run leaves its lock.
    await fs.rm(path.join(dir, 'clay.state.json.lock'));
    await configure(THREE.replace('count = 3', 'count = 4'));
    await clayOutput(dir, 'apply', '-y');

    expect(await beside()).not.toContain('clay.state.json.journal');
    expect(await writtenKeys()).toEqual(['null_resource.a[0]', 'null_resource.a[1]', 'null_resource.a[2]', 'null_resource.a[3]']);
    expect(await writtenKeys('clay.state.json.bak')).toEqual(['null_resource.a[0]', 'null_resource.a[1]', 'null_resource.a[2]']);
  });

  it('is written whole when the run is done', async () => {
    await configure(THREE);

    await clayOutput(dir, 'apply', '-y');

    expect(await beside()).not.toContain('clay.state.json.journal');
  });

  it('is written whole when an action fails', async () => {
    await configure(after('exit 3'));

    await expect(clayOutput(dir, 'apply', '-y')).rejects.toThrow();

    expect(await beside()).not.toContain('clay.state.json.journal');
    const written = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as { resources: object };
    expect(Object.keys(written.resources)).toEqual(['null_resource.a[0]', 'null_resource.a[1]', 'null_resource.a[2]']);
  });

  it('is written whole when the caller stops reading the run', async () => {
    let first = '';

    for await (const event of start(orchestratorIn(dir), THREE))
      if (event.type === 'applied') {
        first = Address.of(event.action).toString();
        break;
      }

    expect(await beside()).not.toContain('clay.state.json.journal');
    const written = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as { resources: object };
    expect(Object.keys(written.resources)).toContain(first);
  });
});
