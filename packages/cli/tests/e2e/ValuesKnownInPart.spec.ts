import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { isUnknown, UNKNOWN } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';
import { createPlanCommand } from '../../src/commands/plan';
import { start } from './start';

/** A map with one value only the apply makes and one the configuration sets, read whole and in parts. */
const config = `
  resource "random_string" "s" { length = 4 }
  variable "m" {
    default = { a = "\${random_string.s.id}", b = "fixed" }
  }
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
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('plans a map with what is known, the rest as known after apply', async () => {
    const { outputs } = await newOrchestrator().plan(config);

    expect(outputs.whole.new).toEqual({ a: UNKNOWN, b: 'fixed' });
    expect(outputs.known.new).toBe('fixed');
    expect(isUnknown(outputs.later.new)).toBe(true);
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
    expect(outputs).toEqual({ whole: { a: resources['random_string.s'].id, b: 'fixed' }, known: 'fixed', later: `read ${resources['random_string.s'].id}` });
  });

  // The provider checks what it can once the apply knows the rest.
  it('leaves a value known in part for the provider to check at apply', async () => {
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

    expect(validate.mock.calls.map(([type]) => type)).toEqual(['random_string']);
  });

  it('reads into what is not known yet as not known yet', async () => {
    const { outputs } = await newOrchestrator().plan(`${config}\noutput "into" { value = "\${var.m.a.x}" }`);

    expect(isUnknown(outputs.into.new)).toBe(true);
  });

  // The plan cannot tell an attribute the resource will have from one it never will; the apply can, and says so rather than send the provider nothing.
  it('refuses at apply an item the apply cannot read, though the plan left it for the apply', async () => {
    const withMissing = `
      resource "local_file" "f" {
        path = "${path.join(dir, 'f.txt')}"
        content = "x"
      }
      resource "null_resource" "n" {
        triggers = { a = "\${local_file.f.nosuch}" }
      }
    `;

    const events = [];
    for await (const event of start(newOrchestrator(), withMissing)) events.push(event);

    const failed = events.find((event) => event.type === 'failed');
    expect(failed?.type === 'failed' && failed.error.message).toContain('Attribute "nosuch" not found on resource');
  });

  it('refuses a for_each known in part, where it is written', async () => {
    const withForEach = `
      resource "random_string" "s" { length = 4 }
      resource "null_resource" "n" {
        for_each = { a = "\${random_string.s.id}" }
      }
    `;

    const error = await newOrchestrator()
      .plan(withForEach)
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toBe('for_each must be known when planning: it reads a value only an apply makes');
  });
});
