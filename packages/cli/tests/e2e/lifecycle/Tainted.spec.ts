import { State } from '@clay/contracts';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clayOutput } from '../helpers';

describe('a tainted resource', () => {
  let dir: string;

  const clayIn = (...args: string[]) => clayOutput(dir, ...args);
  const file = (name: string) => path.join(dir, name);

  const stateOf = async () => JSON.parse(await fs.readFile(file('clay.state.json'), 'utf8')) as State;

  /** As a provisioner that fails after the create leaves it. */
  const taint = async (address: string) => {
    const state = await stateOf();
    state.resources[address].tainted = true;
    await fs.writeFile(file('clay.state.json'), JSON.stringify(state), 'utf8');
  };

  const written = async (content: string) => {
    const config = `resource "local_file" "f" {\n  path    = "${file('a.txt')}"\n  content = "${content}"\n  lifecycle {\n    ignore_changes = [content]\n  }\n}\n`;
    await fs.writeFile(file('main.clay'), config, 'utf8');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-tainted-'));
    await clayIn('init');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is replaced by the next plan, though the configuration is the same, and says why', async () => {
    await fs.writeFile(file('main.clay'), 'resource "null_resource" "n" {}\n', 'utf8');
    await clayIn('apply', '--yes');
    await taint('null_resource.n');

    const output = await clayIn('plan');

    expect(output).toContain('null_resource.n will be replaced\n      tainted, so it is replaced');
  });

  it('is a new object once applied, which is not tainted', async () => {
    await fs.writeFile(file('main.clay'), 'resource "null_resource" "n" {}\n', 'utf8');
    await clayIn('apply', '--yes');
    const before = await stateOf();
    await taint('null_resource.n');

    await clayIn('apply', '--yes');

    const after = await stateOf();
    const replaced = after.resources['null_resource.n'];
    const { id } = before.resources['null_resource.n'].attributes;
    expect(replaced.attributes.id).not.toBe(id);
    expect(replaced.tainted).toBeUndefined();
  });

  it('is replaced through a saved plan, which carries the taint', async () => {
    await fs.writeFile(file('main.clay'), 'resource "null_resource" "n" {}\n', 'utf8');
    await clayIn('apply', '--yes');
    const before = await stateOf();
    await taint('null_resource.n');
    await clayIn('plan', '--out', 'saved.plan');

    const output = await clayIn('apply', 'saved.plan');

    const after = await stateOf();
    expect(output).toContain('tainted, so it is replaced');
    expect(after.resources['null_resource.n'].attributes.id).not.toBe(before.resources['null_resource.n'].attributes.id);
  });

  it('leaves the old object deposed until the new one is made, where create_before_destroy is set', async () => {
    const config = 'resource "null_resource" "n" {\n  lifecycle {\n    create_before_destroy = true\n  }\n}\n';
    await fs.writeFile(file('main.clay'), config, 'utf8');
    await clayIn('apply', '--yes');
    await taint('null_resource.n');

    const output = await clayIn('apply', '--yes');

    const after = await stateOf();
    expect(output).toContain('null_resource.n will be replaced, the new one created first\n      tainted, so it is replaced');
    expect(after.resources['null_resource.n'].tainted).toBeUndefined();
    expect(after.deposed).toBeUndefined();
  });

  it('keeps none of its values through ignore_changes, since the new object is made from the configuration', async () => {
    await written('one');
    await clayIn('apply', '--yes');
    await written('two');
    await taint('local_file.f');

    await clayIn('apply', '--yes');

    expect(await fs.readFile(file('a.txt'), 'utf8')).toBe('two');
  });

  it('is marked so by state show', async () => {
    await fs.writeFile(file('main.clay'), 'resource "null_resource" "n" {}\n', 'utf8');
    await clayIn('apply', '--yes');
    await taint('null_resource.n');

    const output = await clayIn('state', 'show', 'null_resource.n');

    expect(output).toContain('# null_resource.n (tainted):');
  });
});
