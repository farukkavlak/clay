import { Address } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { parsePlanFile, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, moveResource, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../src/commands/apply';
import { createPlanCommand } from '../../src/commands/plan';
import { start } from './start';

/** A random string is made anew on every create, so the same id after a run means it was kept, not made again. */
const suffix = (count?: string) => `resource "random_string" "s" { ${count ? `count = ${count} ` : ''}length = 8 }`;

describe('a resource that gains or loses count', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  /** A file named after what it reads; a path is replaced on change. */
  const reader = (reference: string) => `resource "local_file" "f" { path = "${path.join(dir, '${' + reference + '}.txt')}" content = "x" }`;

  const ids = async () => {
    const state = await new LocalBackend(dir).read();
    return Object.fromEntries(Object.entries(state.resources).map(([address, resource]) => [address, resource.id]));
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-count-move-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('moves the resource to its first instance when count is added, and keeps it', async () => {
    await apply(suffix());
    const { 'random_string.s': id } = await ids();

    const plan = await newOrchestrator().plan(suffix('1'));
    await apply(suffix('1'));

    expect(plan.actions).toEqual([expect.objectContaining({ type: 'NO_OP', name: 's', key: 0, movedFrom: 'random_string.s' })]);
    expect(await ids()).toEqual({ 'random_string.s[0]': id });
  });

  it('moves the first instance back when count is taken off, and destroys the rest', async () => {
    await apply(suffix('2'));
    const { 'random_string.s[0]': first } = await ids();

    await apply(suffix());

    expect(await ids()).toEqual({ 'random_string.s': first });
  });

  it('updates a resource it moves in the same step', async () => {
    const file = (count: string, content: string) => `resource "local_file" "f" { ${count} path = "${path.join(dir, 'f.txt')}" content = "${content}" }`;
    await apply(file('', 'old'));

    const plan = await newOrchestrator().plan(file('count = 1', 'new'));
    await apply(file('count = 1', 'new'));

    expect(plan.actions).toEqual([expect.objectContaining({ type: 'UPDATE', key: 0, movedFrom: 'local_file.f' })]);
    expect(await fs.readFile(path.join(dir, 'f.txt'), 'utf8')).toBe('new');
    expect(Object.keys(await ids())).toEqual(['local_file.f[0]']);
  });

  // The reader names the file after the id, and a path is replaced on change: a reader that saw the id as unknown would be made again.
  it('plans what reads a moved resource with its value known, so it stays as it is', async () => {
    await apply(`${suffix()}\n${reader('random_string.s.id')}`);

    const plan = await newOrchestrator().plan(`${suffix('1')}\n${reader('random_string.s[0].id')}`);

    expect(plan.actions.map((action) => [action.type, action.name])).toEqual([
      ['NO_OP', 's'],
      ['NO_OP', 'f'],
    ]);
  });

  it('moves a resource in a module to its first instance, and back', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    const inModule = async (count?: string) => {
      await fs.writeFile(path.join(dir, 'm', 'main.clay'), suffix(count), 'utf8');
      await apply('module "m" { source = "./m" }');
    };
    await inModule();
    const { 'module.m.random_string.s': id } = await ids();

    await inModule('2');
    const counted = await ids();
    expect(counted['module.m.random_string.s[0]']).toBe(id);

    await inModule();
    expect(await ids()).toEqual({ 'module.m.random_string.s': id });
  });

  it('moves nothing over an instance state already holds', async () => {
    await apply(suffix('2'));
    const backend = new LocalBackend(dir);
    const state = await backend.read();
    moveResource(state, Address.parse('random_string.s[1]'), Address.parse('random_string.s'));
    await backend.write(state);
    const before = await ids();

    const plan = await newOrchestrator().plan(suffix('1'));

    expect(plan.actions.map((action) => [action.type, Address.of(action).toString(), action.movedFrom])).toEqual([
      ['NO_OP', 'random_string.s[0]', undefined],
      ['DELETE', 'random_string.s', undefined],
    ]);
    await apply(suffix('1'));
    expect(await ids()).toEqual({ 'random_string.s[0]': before['random_string.s[0]'] });
  });

  it('replaces a resource it moves when a change forces it, and keeps only the new one', async () => {
    await apply(suffix());
    const { 'random_string.s': id } = await ids();

    await apply(`resource "random_string" "s" { count = 1 length = 9 }`);

    const after = await ids();
    expect(Object.keys(after)).toEqual(['random_string.s[0]']);
    expect(after['random_string.s[0]']).not.toBe(id);
  });

  it('destroys the resource under its own address when count is 0, since nothing takes its place', async () => {
    await apply(suffix());

    const plan = await newOrchestrator().plan(suffix('0'));

    expect(plan.actions).toEqual([expect.objectContaining({ type: 'DELETE', name: 's', key: undefined })]);
    expect(plan.actions[0]).not.toHaveProperty('movedFrom');
  });

  it('runs a saved plan that moves a resource', async () => {
    await apply(suffix());
    const { 'random_string.s': id } = await ids();
    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(suffix('1')), suffix('1'), {}), 'plan.json');

    for await (const event of newOrchestrator().runPlan(saved, suffix('1'))) if (event.type === 'failed') throw event.error;

    expect(await ids()).toEqual({ 'random_string.s[0]': id });
  });
});

// The commands read the current directory, so they run from a temp one.
describe('how the CLI shows a resource that gains count', () => {
  let dir: string;
  let cwd: string;
  let printed: string[];

  const write = (config: string) => fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-count-move-cli-'));
    cwd = process.cwd();
    process.chdir(dir);
    printed = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => printed.push(args.join(' ')));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    await write(suffix());
    await createApplyCommand().parseAsync(['node', 'clay', '--yes']);
    printed.length = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('plans a move as a change of its own', async () => {
    await write(suffix('1'));

    await createPlanCommand().parseAsync(['node', 'clay']);

    const output = printed.join('\n');
    expect(output).toContain('> random_string.s[0] will be moved from random_string.s');
    expect(output).toContain('Plan: 0 to add, 0 to change, 0 to destroy, 1 to move.');
  });

  it('applies a plan that only moves, and counts the move', async () => {
    await write(suffix('1'));

    await createApplyCommand().parseAsync(['node', 'clay', '--yes']);

    const output = printed.join('\n');
    expect(output).toContain('random_string.s[0] moved from random_string.s');
    expect(output).toContain('Resources: 0 added, 0 changed, 0 destroyed, 1 moved.');
  });

  it('shows a replacement it moves with where it moved from', async () => {
    await write(`resource "random_string" "s" { count = 1 length = 9 }`);

    await createPlanCommand().parseAsync(['node', 'clay']);

    expect(printed.join('\n')).toContain('will be replaced, moved from random_string.s');
  });
});
