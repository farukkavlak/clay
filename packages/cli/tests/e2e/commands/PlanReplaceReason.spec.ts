import { State } from '@clay/core';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clayOutput } from '../helpers';

const fileConfig = (where: string, content: string) => `resource "local_file" "f" {\n  path    = ${where}\n  content = "${content}"\n}\n`;
const hiddenPathConfig = (where: string) => `variable "where" {\n  default   = "${where}"\n  sensitive = true\n}\n${fileConfig('var.where', 'one')}`;

describe('what the plan says forces a replace', () => {
  let dir: string;

  const clayIn = (...args: string[]) => clayOutput(dir, ...args);
  const file = (name: string) => path.join(dir, name);
  const configure = (config: string) => fs.writeFile(file('main.clay'), config, 'utf8');

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-replace-reason-'));
    await clayIn('init');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('names the attribute that forces it, not one that only changes with it', async () => {
    await configure(fileConfig('"a.txt"', 'one'));
    await clayIn('apply', '--yes');
    await configure(fileConfig('"b.txt"', 'two'));

    expect(await clayIn('plan')).toContain('local_file.f will be replaced\n      replace forced by: path\n      path: "a.txt" -> "b.txt"');
  });

  it('names each attribute that forces it', async () => {
    await configure('resource "random_string" "r" {\n  length = 8\n}\n');
    await clayIn('apply', '--yes');
    await configure('resource "random_string" "r" {\n  length  = 9\n  special = true\n}\n');

    expect(await clayIn('plan')).toContain('replace forced by: length, special\n');
  });

  it('says it again when a saved plan is applied', async () => {
    await configure(fileConfig('"a.txt"', 'one'));
    await clayIn('apply', '--yes');
    await configure(fileConfig('"b.txt"', 'one'));
    await clayIn('plan', '--out', 'saved.json');

    expect(await clayIn('apply', 'saved.json')).toContain('replace forced by: path\n');
  });

  it('names a sensitive attribute and keeps its value hidden', async () => {
    await configure(hiddenPathConfig('hidden-a.txt'));
    await clayIn('apply', '--yes');
    await configure(hiddenPathConfig('hidden-b.txt'));

    const output = await clayIn('plan');

    expect(output).toContain('replace forced by: path\n');
    expect(output).not.toContain('hidden-');
  });

  it('names nothing for a tainted resource, which no attribute forces', async () => {
    await configure(fileConfig('"a.txt"', 'one'));
    await clayIn('apply', '--yes');
    const state = JSON.parse(await fs.readFile(file('clay.state.json'), 'utf8')) as State;
    state.resources['local_file.f'].tainted = true;
    await fs.writeFile(file('clay.state.json'), JSON.stringify(state), 'utf8');

    const output = await clayIn('plan');

    expect(output).toContain('tainted, so it is replaced');
    expect(output).not.toContain('replace forced by');
  });
});
