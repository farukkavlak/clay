import { Address, ExactNumber, isUnknown, UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';
import { createPlanCommand } from '../../src/commands/plan';
import { start } from './start';

/** A map with one value only the apply makes and one the configuration sets, given to a module and read whole and in parts. */
const config = `
  resource "random_string" "s" { length = 4 }
  module "k" {
    source = "./k"
    m      = { a = "\${random_string.s.id}", b = "fixed" }
  }
  output "whole" { value = module.k.whole }
  output "known" { value = module.k.known }
  output "later" { value = module.k.later }
`;

const module = `
  variable "m" {}
  output "whole" { value = var.m }
  output "known" { value = var.m.b }
  output "later" { value = "read \${var.m.a}" }
`;

// A list or a map is known as far as its items are: one item only the apply makes leaves the rest known.
describe('a value known in part', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  /** Runs a CLI command from the temp directory and returns what it printed. */
  const cli = async (run: () => Promise<unknown>): Promise<string> => {
    const printed: string[] = [];
    const cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void printed.push(args.join(' ')));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    try {
      await run();
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
    }

    return printed.join('\n');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-known-in-part-'));
    await fs.mkdir(path.join(dir, 'k'));
    await fs.writeFile(path.join(dir, 'k', 'main.clay'), module, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('plans a map with what is known, the rest as known after apply', async () => {
    const { outputs } = await newOrchestrator().plan(config);

    expect(outputs.whole.new?.value).toEqual({ a: UNKNOWN, b: 'fixed' });
    expect(outputs.known.new?.value).toBe('fixed');
    expect(isUnknown(outputs.later.new?.value)).toBe(true);
  });

  it('shows what is known of it, and where the rest goes', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');

    const printed = await cli(() => createPlanCommand().parseAsync(['node', 'clay']));

    expect(printed).toContain('whole = {"a":(known after apply),"b":"fixed"}');
  });

  // Any text a value holds is shown as that text, however it reads.
  it('shows a value that holds what looks like a mark as the value it is', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), String.raw`output "x" { value = { a = "\u0000unknown", "\u0000unknown" = "k" } }`, 'utf8');

    const printed = await cli(() => createPlanCommand().parseAsync(['node', 'clay']));

    expect(printed).toContain(String.raw`x = {"a":"\u0000unknown","\u0000unknown":"k"}`);
  });

  // A saved plan is read back from its file, where what is not known has no JSON form of its own.
  it('shows it the same from a saved plan, and applies it in full', async () => {
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
    await cli(() => createPlanCommand().parseAsync(['node', 'clay', '--out', 'plan.json']));

    const printed = await cli(() => createApplyCommand().parseAsync(['node', 'clay', 'plan.json']));

    expect(printed).toContain('Applying from saved plan');
    expect(printed).toContain('whole = {"a":(known after apply),"b":"fixed"}');
    const { outputs, resources } = await new LocalBackend(dir).read();
    const { id } = resources['random_string.s'].attributes;
    expect(Object.fromEntries(Object.entries(outputs ?? {}).map(([name, output]) => [name, output.value]))).toEqual({
      whole: { a: id, b: 'fixed' },
      known: 'fixed',
      later: `read ${id}`,
    });
  });

  // The provider checks what it knows now, and the rest once the apply knows it.
  it('gives the provider a value known in part to check, as it is', async () => {
    const withTriggers = `
      resource "random_string" "s" { length = 4 }
      resource "null_resource" "n" {
        triggers = { a = "\${random_string.s.id}", b = "fixed" }
      }
    `;

    const provider = new LocalProvider();
    const validate = vi.spyOn(provider, 'validate');
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(provider);

    await engine.plan(withTriggers);

    expect(validate.mock.calls).toEqual([
      ['random_string', { length: ExactNumber.parse('4') }],
      ['null_resource', { triggers: { a: UNKNOWN, b: 'fixed' } }],
    ]);
  });

  it('reads into what is not known yet as not known yet', async () => {
    const { outputs } = await newOrchestrator().plan(`${config}\noutput "into" { value = "\${module.k.whole.a.x}" }`);

    expect(isUnknown(outputs.into.new?.value)).toBe(true);
  });

  const applyAll = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const read = (name: string) => fs.readFile(path.join(dir, name), 'utf8');

  // A map's keys are known before its values, so its values can wait for the apply while its instances are planned.
  it('plans an instance for each key of a for_each whose values the apply makes, and applies them', async () => {
    const config = `
      resource "random_string" "s" { length = 4 }
      resource "local_file" "f" {
        for_each = { a = random_string.s.id, b = "fixed" }
        path = "${path.join(dir, '${each.key}.txt')}"
        content = "\${each.value}"
      }
      output "a" { value = { path = local_file.f["a"].path, content = local_file.f["a"].content } }
      output "b" { value = local_file.f["b"].content }
    `;

    const { actions, outputs } = await newOrchestrator().plan(config);

    expect(actions.map((action) => [action.type, Address.of(action).toString()])).toEqual([
      ['CREATE', 'random_string.s'],
      ['CREATE', 'local_file.f["a"]'],
      ['CREATE', 'local_file.f["b"]'],
    ]);
    expect(outputs.a.new?.value).toEqual({ path: path.join(dir, 'a.txt'), content: UNKNOWN });
    expect(outputs.b.new?.value).toBe('fixed');

    await applyAll(config);
    const { resources } = await new LocalBackend(dir).read();
    expect(await read('a.txt')).toBe(resources['random_string.s'].attributes.id);
    expect(await read('b.txt')).toBe('fixed');
  });

  it('plans an instance of a module for each key of a for_each whose values the apply makes, and applies them', async () => {
    await fs.mkdir(path.join(dir, 'page'));
    await fs.writeFile(
      path.join(dir, 'page', 'main.clay'),
      `
        variable "name" {}
        variable "body" {}
        resource "local_file" "page" {
          path = "${path.join(dir, '${var.name}.txt')}"
          content = "\${var.body}"
        }
        output "content" { value = local_file.page.content }
      `,
      'utf8'
    );
    const config = `
      resource "random_string" "s" { length = 4 }
      module "page" {
        source = "./page"
        for_each = { a = random_string.s.id, b = "fixed" }
        name = "\${each.key}"
        body = "\${each.value}"
      }
      output "a" { value = module.page["a"].content }
      output "b" { value = module.page["b"].content }
    `;

    const { actions, outputs } = await newOrchestrator().plan(config);

    expect(actions.map((action) => [action.type, Address.of(action).toString()])).toEqual([
      ['CREATE', 'random_string.s'],
      ['CREATE', 'module.page["a"].local_file.page'],
      ['CREATE', 'module.page["b"].local_file.page'],
    ]);
    expect(isUnknown(outputs.a.new?.value)).toBe(true);
    expect(outputs.b.new?.value).toBe('fixed');

    await applyAll(config);
    const { resources } = await new LocalBackend(dir).read();
    expect(await read('a.txt')).toBe(resources['random_string.s'].attributes.id);
    expect(await read('b.txt')).toBe('fixed');
  });

  it('reads into a value of a for_each the apply makes as not known yet', async () => {
    const { outputs } = await newOrchestrator().plan(`
      resource "random_string" "s" { length = 4 }
      resource "null_resource" "n" {
        for_each = { a = { id = random_string.s.id, name = "x" } }
        triggers = { id = each.value.id, name = each.value.name }
      }
      output "triggers" { value = null_resource.n["a"].triggers }
    `);

    expect(outputs.triggers.new?.value).toEqual({ id: UNKNOWN, name: 'x' });
  });
});
