import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { parsePlanFile, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

const drain = async (events: AsyncGenerator<{ type: string; error?: Error }>) => {
  for await (const event of events) if (event.type === 'failed') throw event.error;
};

describe('a reference that reads into a list or a map', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = (config: string) => drain(start(newOrchestrator(), config));
  const written = (name: string) => fs.readFile(path.join(dir, name), 'utf8');
  const file = (name: string, content: string) => `resource "local_file" "${name}" { path = "${path.join(dir, `${name}.txt`)}" content = ${content} }`;

  const planError = async (config: string): Promise<ConfigError> => {
    try {
      await newOrchestrator().plan(config);
    } catch (error) {
      if (error instanceof ConfigError) return error;

      throw error;
    }

    throw new Error('Expected the plan to fail');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-nested-access-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads a key of a map another resource was given, and plans no change once applied', async () => {
    const config = `
      resource "null_resource" "a" { triggers = { env = "prod" } }
      ${file('f', 'null_resource.a.triggers.env')}
    `;
    await apply(config);

    const { actions } = await newOrchestrator().plan(config);

    expect(await written('f.txt')).toBe('prod');
    expect(actions.map((action) => action.type)).toEqual(['NO_OP', 'NO_OP']);
  });

  it('reads an item of a list and a key of a map, bare and inside a string', async () => {
    await apply(`
      variable "names" { default = ["ana", "bo"] }
      variable "tags" { default = { team = "core", "a.b" = "dotted" } }
      ${file('bare', 'var.tags["team"]')}
      ${file('joined', '"${var.names[1]}-${var.tags.team}"')}
      ${file('quoted', '"key ${var.tags["a.b"]}"')}
    `);

    expect(await written('bare.txt')).toBe('core');
    expect(await written('joined.txt')).toBe('bo-core');
    expect(await written('quoted.txt')).toBe('key dotted');
  });

  it('reads into what a module gives back', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'output "info" { value = { url = "http://x", ports = [80, 443] } }', 'utf8');

    await apply(`
      module "m" { source = "./m" }
      ${file('f', '"${module.m.info.url}:${module.m.info.ports[1]}"')}
    `);

    expect(await written('f.txt')).toBe('http://x:443');
  });

  // A missing key is a typo; planning it as unknown would hide it until apply.
  it('refuses a key the map does not have, where it is written, rather than plan it as unknown', async () => {
    await apply('resource "null_resource" "a" { triggers = { env = "prod" } }');

    const error = await planError(`resource "null_resource" "a" { triggers = { env = "prod" } }\n${file('f', 'null_resource.a.triggers.ennv')}`);

    expect(error.message).toBe('null_resource.a.triggers has no key "ennv"');
    expect(error.position).toMatchObject({ line: 2 });
  });

  it('refuses an index past the end of a list', async () => {
    const error = await planError(`variable "names" { default = ["ana"] }\n${file('f', 'var.names[1]')}`);

    expect(error.message).toBe('var.names has no item [1]: it holds 1');
  });

  it.each([
    ['in brackets', 'var.tags["env"]["x"]', 'var.tags["env"] is a string and cannot be read into'],
    ['after a dot', 'var.tags.env.x', 'var.tags.env is a string and cannot be read into'],
  ])('names a step into a value as it was written, %s', async (_, reference, message) => {
    const error = await planError(`variable "tags" { default = { env = "prod" } }\n${file('f', reference)}`);

    expect(error.message).toBe(message);
  });

  // Scope keys join names with dots, so a quoted part like `"a.b"` could reach a module two levels down.
  it('refuses a quoted key where the reference needs a name, rather than read a module the caller never called', async () => {
    await fs.mkdir(path.join(dir, 'a', 'b'), { recursive: true });
    await fs.writeFile(path.join(dir, 'a', 'b', 'main.clay'), 'output "secret" { value = "inner" }', 'utf8');
    await fs.writeFile(path.join(dir, 'a', 'main.clay'), 'module "b" { source = "./b" }', 'utf8');

    const error = await planError(`module "a" { source = "./a" }\n${file('f', 'module["a.module.b"].secret')}`);

    expect(error.message).toBe('Reference "module["a.module.b"].secret" has "a.module.b" where it needs a name');
    expect(error.position).toMatchObject({ line: 2 });
  });

  // Every number in a saved plan reads back as an ExactNumber; an index must come back as a plain number.
  it('runs an index out of a saved plan', async () => {
    const config = `variable "names" { default = ["ana", "bo"] }\n${file('f', 'var.names[1]')}`;
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

    await drain(newOrchestrator().runPlan(saved, saved.config));

    expect(await written('f.txt')).toBe('bo');
  });
});
