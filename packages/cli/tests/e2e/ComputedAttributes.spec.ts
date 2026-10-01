import { isUnknown, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

/** A resource whose `made` the provider makes, once it has made or changed the resource, unless the configuration sets it. */
class StampProvider implements Provider {
  readonly resources = ['stamp'];
  readonly dataSources: string[] = [];

  async getSchema(): Promise<Schema> {
    return { label: { type: 'string', required: true }, note: { type: 'string' }, made: { type: 'string', computed: true, optional: true } };
  }

  async plan(type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(), request);
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

/** Says it computes `made`, then does not return it. */
class ForgetfulStampProvider extends StampProvider {
  override async create(_type: string, inputs: Record<string, unknown>): Promise<{ id: string; attributes: Record<string, unknown> }> {
    return { id: 'stamp-id', attributes: inputs };
  }
}

/** Makes a `serial` from its `size`, which replaces it, so the serial is the same until the resource is replaced. */
class SerialStampProvider extends StampProvider {
  override async getSchema(): Promise<Schema> {
    return { ...(await super.getSchema()), size: { type: 'string', forceNew: true }, serial: { type: 'string', computed: true, kept: true } };
  }

  override async create(type: string, inputs: Record<string, unknown>): Promise<{ id: string; attributes: Record<string, unknown> }> {
    const { id, attributes } = await super.create(type, inputs);
    return { id, attributes: { ...attributes, serial: `serial ${String(inputs.size)}` } };
  }

  override async update(id: string, type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { ...(await super.update(id, type, inputs)), serial: `serial ${String(inputs.size)}` };
  }
}

describe('a value only the provider knows', () => {
  let dir: string;
  let file: string;

  const newOrchestrator = (stamp: Provider = new StampProvider()) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    engine.registerProvider(stamp);
    return engine;
  };

  const apply = async (config: string, stamp?: Provider) => {
    for await (const event of start(newOrchestrator(stamp), config)) if (event.type === 'failed') throw event.error;
  };

  const serialCopy = (label: string, size = '1') =>
    `resource "stamp" "a" {\n  label = "${label}"\n  size = "${size}"\n}\nresource "local_file" "copy" {\n  path = "${file}"\n  content = stamp.a.serial\n}`;

  const withCopy = (stamp: string) => `${stamp}\nresource "local_file" "copy" {\n  path = "${file}"\n  content = stamp.a.made\n}`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-computed-'));
    file = path.join(dir, 'copy.txt');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads what random_string made and what command_exec printed', async () => {
    const config = `
      resource "random_string" "r" { length = 5 }
      resource "command_exec" "c" { command = "echo printed" }
      resource "local_file" "copy" {
        path = "${file}"
        content = "\${random_string.r.result} \${command_exec.c.stdout}"
      }
    `;

    await apply(config);

    const state = await new LocalBackend(dir).read();
    expect(await fs.readFile(file, 'utf8')).toBe(`${String(state.resources['random_string.r'].attributes.result)} printed\n`);
    expect(state.resources['random_string.r'].attributes.result).toHaveLength(5);
  });

  // A name the configuration does not set and the provider does not compute is never known.
  it.each([
    ['a name the resource does not have', 'stamp.a.nope', 'nope'],
    ['a value the configuration leaves unset', 'stamp.a.note', 'note'],
  ])('refuses a reference to %s, where it is written', async (_, reference, name) => {
    const config = `resource "stamp" "a" { label = "x" }\noutput "o" { value = ${reference} }`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: `"${reference}" will never be known: the configuration does not set ${name} and stamp does not compute it`,
      position: { file: 'main.clay', line: 2, column: 22 },
    });
  });

  it('refuses at apply an item the plan left for the apply, when the provider does not return it', async () => {
    const config = 'resource "stamp" "a" { label = "x" }\nresource "null_resource" "n" {\n  triggers = { a = stamp.a.made }\n}';

    await expect(apply(config, new ForgetfulStampProvider())).rejects.toThrow('Attribute "made" not found on resource');
  });

  it('refuses a reference to a name a resource that does not change has not got, where it is written', async () => {
    await apply('resource "stamp" "a" { label = "x" }');

    await expect(newOrchestrator().plan('resource "stamp" "a" { label = "x" }\noutput "o" { value = stamp.a.nope }')).rejects.toMatchObject({
      message: 'Invalid resource reference "stamp.a.nope": Attribute "nope" not found on resource',
      position: { file: 'main.clay', line: 2, column: 22 },
    });
  });

  // Only the provider makes it, so a value the configuration gave it would show in the plan and never be applied.
  it.each([
    ['random_string', 'result', 'length = 4'],
    ['command_exec', 'stdout', 'command = "echo x"'],
  ])('refuses %s %s set by the configuration, where it is written', async (type, name, set) => {
    const config = `resource "${type}" "a" {\n  ${set}\n  ${name} = "mine"\n}`;

    await expect(newOrchestrator().plan(config)).rejects.toMatchObject({
      message: `${name} is computed by ${type} and cannot be set`,
      position: { file: 'main.clay', line: 3, column: name.length + 6 },
      block: `resource "${type}" "a"`,
    });
  });

  // Whether the provider takes a name its schema does not have is for the provider to say.
  it('plans a name the schema does not have', async () => {
    const { actions } = await newOrchestrator().plan('resource "stamp" "a" {\n  label = "x"\n  extra = "y"\n}');

    expect(actions.map(({ type }) => type)).toEqual(['CREATE']);
  });

  it('reads the id of a resource still to be made as known after apply', async () => {
    const { outputs } = await newOrchestrator().plan('resource "stamp" "a" { label = "x" }\noutput "o" { value = stamp.a.id }');

    expect(isUnknown(outputs.o.new)).toBe(true);
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

  // Any change makes the provider compute its values again, so what it made before is known only after apply.
  it('still plans a value the configuration stops setting as removed', async () => {
    await apply('resource "stamp" "a" {\n  label = "x"\n  note = "n"\n}');

    const { actions } = await newOrchestrator().plan('resource "stamp" "a" { label = "x" }');

    expect(actions.map(({ type, changes }) => ({ type, changes }))).toEqual([
      { type: 'UPDATE', changes: { note: { old: 'n', new: undefined }, made: { old: 'made x', new: UNKNOWN } } },
    ]);
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

  it('leaves what reads a kept value unchanged when the resource changes in place, and the apply keeps it', async () => {
    await apply(serialCopy('x'), new SerialStampProvider());

    const { actions } = await newOrchestrator(new SerialStampProvider()).plan(serialCopy('y'));
    await apply(serialCopy('y'), new SerialStampProvider());

    expect(actions.map(({ name, type }) => [name, type])).toEqual([
      ['a', 'UPDATE'],
      ['copy', 'NO_OP'],
    ]);
    const state = await new LocalBackend(dir).read();
    expect(state.resources['stamp.a'].attributes).toMatchObject({ label: 'y', serial: 'serial 1' });
    expect(await fs.readFile(file, 'utf8')).toBe('serial 1');
  });

  it('plans a kept value as known after apply when the resource is replaced, and what reads it changes', async () => {
    await apply(serialCopy('x'), new SerialStampProvider());

    const { actions } = await newOrchestrator(new SerialStampProvider()).plan(serialCopy('x', '2'));
    await apply(serialCopy('x', '2'), new SerialStampProvider());

    expect(actions.map(({ name, type }) => [name, type])).toEqual([
      ['a', 'REPLACE'],
      ['copy', 'UPDATE'],
    ]);
    expect(isUnknown(actions.find((action) => action.name === 'copy')!.planned!.content)).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('serial 2');
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
