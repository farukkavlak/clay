import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError, CONFIG_FILE } from '@clay/parser';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

describe('a string with an interpolation', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const applied = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
    const state = await new LocalBackend(dir).read();
    return state.resources;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-interpolation-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is the value itself when the whole string is one interpolation', async () => {
    const config = `
      variable "n" { default = 8 }
      variable "tags" { default = ["a", "b"] }
      resource "random_string" "s" { length = "\${var.n}" }
      resource "null_resource" "t" { tags = "\${var.tags}" }
    `;

    const resources = await applied(config);

    expect(resources['random_string.s'].attributes.length).toBe(8);
    expect(resources['null_resource.t'].attributes.tags).toEqual(['a', 'b']);
  });

  it('passes a map from state through whole, keys named type and value included', async () => {
    const config = `
      resource "null_resource" "a" { settings = { type = "a", value = "b" } }
      resource "null_resource" "b" { copied = "\${null_resource.a.settings}" }
    `;

    const resources = await applied(config);

    expect(resources['null_resource.b'].attributes.copied).toEqual({ type: 'a', value: 'b' });
  });

  it('is text when there is text around the interpolation', async () => {
    const config = `
      variable "n" { default = 8 }
      resource "local_file" "f" { path = "${path.join(dir, 'f.txt')}" content = "n=\${var.n}" }
    `;

    const resources = await applied(config);

    expect(resources['local_file.f'].attributes.content).toBe('n=8');
  });

  // The same list, read from five places: each error has to name the block that reads it and point at the line.
  it.each([
    ['a resource', 'resource "null_resource" "t" { label = "tags: ${var.tags}" }', 'resource "null_resource" "t"', 40],
    ['a variable default', 'variable "v" { default = "tags: ${var.tags}" }', 'variable "v"', 26],
    ['an output', 'output "o" { value = "tags: ${var.tags}" }', 'output "o"', 22],
    ['a module input', 'module "m" { source = "./m" text = "tags: ${var.tags}" }', 'module "m"', 36],
    ['a data source', 'data "local_file" "f" { path = "tags: ${var.tags}" }', 'data "local_file" "f"', 32],
  ])('refuses to join a list into text in %s, and says which block reads it', async (_, block, declaration, column) => {
    await fs.mkdir(path.join(dir, 'm'), { recursive: true });
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'variable "text" {}', 'utf8');
    const config = `variable "tags" { default = ["a", "b"] }\n${block}`;

    const planned = newOrchestrator().plan(config);

    await expect(planned).rejects.toBeInstanceOf(ConfigError);
    await expect(planned).rejects.toMatchObject({
      message: '"tags: ${var.tags}" cannot be joined into a string: var.tags is a list',
      block: declaration,
      position: { file: CONFIG_FILE, line: 2, column },
    });
  });
});
