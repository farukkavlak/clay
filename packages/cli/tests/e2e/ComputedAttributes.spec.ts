import { Provider, Schema } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { isUnknown } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

/** A resource whose `made` only the provider knows, once it has made or changed the resource. */
class StampProvider implements Provider {
  readonly resources = ['stamp'];
  readonly dataSources: string[] = [];

  async getSchema(): Promise<Schema> {
    return { label: { type: 'string', required: true }, note: { type: 'string' }, made: { type: 'string', computed: true } };
  }

  async validate(): Promise<void> {}

  async read(_type: string, _id: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, inputs: Record<string, unknown>): Promise<{ id: string; attributes: Record<string, unknown> }> {
    return { id: 'stamp-id', attributes: { ...inputs, made: `made ${String(inputs.label)}` } };
  }

  async update(_id: string, _type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { ...inputs, made: `remade ${String(inputs.label)}` };
  }

  async delete(): Promise<void> {}

  async validateDataSource(): Promise<void> {}

  async readDataSource(): Promise<Record<string, unknown>> {
    return {};
  }
}

describe('a value only the provider knows', () => {
  let dir: string;
  let file: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    engine.registerProvider(new StampProvider());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const withCopy = (stamp: string) => `${stamp}\nresource "local_file" "copy" {\n  path = "${file}"\n  content = stamp.a.made\n}`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-computed-'));
    file = path.join(dir, 'copy.txt');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps what the provider returns in state', async () => {
    await apply('resource "stamp" "a" { label = "x" }');

    const state = await new LocalBackend(dir).read();
    expect(state.resources['stamp.a']).toMatchObject({ id: 'stamp-id', attributes: { label: 'x', made: 'made x' } });
  });

  // The configuration never sets it, so it is no change that the configuration does not have it.
  it('plans nothing for a value only the provider knows', async () => {
    await apply('resource "stamp" "a" { label = "x" }');

    const { actions } = await newOrchestrator().plan('resource "stamp" "a" { label = "x" }');

    expect(actions.map(({ type }) => type)).toEqual(['NO_OP']);
  });

  it('plans a value only the provider knows as a change when the configuration sets it', async () => {
    await apply('resource "stamp" "a" { label = "x" }');

    const { actions } = await newOrchestrator().plan('resource "stamp" "a" {\n  label = "x"\n  made = "mine"\n}');

    expect(actions.map(({ type, changes }) => ({ type, changes }))).toEqual([{ type: 'UPDATE', changes: { made: { old: 'made x', new: 'mine' } } }]);
  });

  it('still plans a value the configuration stops setting as removed', async () => {
    await apply('resource "stamp" "a" {\n  label = "x"\n  note = "n"\n}');

    const { actions } = await newOrchestrator().plan('resource "stamp" "a" { label = "x" }');

    expect(actions.map(({ type, changes }) => ({ type, changes }))).toEqual([{ type: 'UPDATE', changes: { note: { old: 'n', new: undefined } } }]);
  });

  it('plans a value a resource to be made will have as known after apply, and the apply reads it', async () => {
    const config = withCopy('resource "stamp" "a" { label = "x" }');

    const { actions } = await newOrchestrator().plan(config);
    await apply(config);

    expect(isUnknown(actions.find((action) => action.name === 'copy')!.planned!.content)).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('made x');
  });

  it('reads the value from state for a resource that does not change', async () => {
    await apply('resource "stamp" "a" { label = "x" }');

    const { actions } = await newOrchestrator().plan(withCopy('resource "stamp" "a" { label = "x" }'));

    expect(actions.find((action) => action.name === 'copy')!.planned).toMatchObject({ content: 'made x' });
  });

  // The provider may make it again on a change, so the plan cannot say what it will be.
  it('plans the value as known after apply for a resource that changes, and keeps what the provider returns', async () => {
    await apply(withCopy('resource "stamp" "a" { label = "x" }'));
    const config = withCopy('resource "stamp" "a" { label = "y" }');

    const { actions } = await newOrchestrator().plan(config);
    await apply(config);

    expect(isUnknown(actions.find((action) => action.name === 'copy')!.planned!.content)).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('remade y');
    const state = await new LocalBackend(dir).read();
    expect(state.resources['stamp.a'].attributes).toEqual({ label: 'y', made: 'remade y' });
  });
});
