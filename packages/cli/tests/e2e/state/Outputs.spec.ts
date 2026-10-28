import { types, UNKNOWN } from '@clay/contracts';

import { LocalBackend } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApplyCommand } from '../../../src/commands/apply';
import { orchestratorIn } from '../helpers';
import { start } from '../start';

const drain = async (events: AsyncGenerator<{ type: string; error?: Error }>) => {
  for await (const event of events) if (event.type === 'failed') throw event.error;
};

describe('outputs in the state file', () => {
  let dir: string;

  const newOrchestrator = () => orchestratorIn(dir);

  const withOutput = (name: string) => `
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "hello"
    }
    output "${name}" { value = "\${local_file.a.content}" }
  `;

  // b's path is under a file, so its create fails after a's update succeeds.
  const failing = () => `
    resource "local_file" "a" {
      path = "${path.join(dir, 'a.txt')}"
      content = "changed"
    }
    resource "local_file" "b" {
      path = "${path.join(dir, 'a.txt', 'b.txt')}"
      content = "never"
    }
    output "greeting" { value = "\${local_file.a.content} \${local_file.b.content}" }
  `;

  const lateAndEarly = (late: string) => `${withOutput('late').replace('${local_file.a.content}', late)}\noutput "early" { value = "now" }`;

  const run = async (config: string) => {
    let failed: Error | undefined;
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') failed = event.error;
    return failed;
  };

  const stored = async () => new LocalBackend(dir).read();

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-outputs-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('plans a renamed output as a change, with nothing else to do', async () => {
    await run(withOutput('greeting'));

    const plan = await newOrchestrator().plan(withOutput('message'));

    expect(plan.actions.every((action) => action.type === 'NO_OP')).toBe(true);
    const hello = { value: 'hello', type: types.string };
    expect(plan.outputs).toEqual({ greeting: { old: hello, new: undefined }, message: { old: undefined, new: hello } });
  });

  // The configuration sets the content, but only the apply knows the id.
  it('plans an output that a resource to be created feeds with what its configuration sets, and with the id its provider plans', async () => {
    const plan = await newOrchestrator().plan(`${withOutput('greeting')}\noutput "id" { value = "\${local_file.a.id}" }`);

    expect(plan.outputs.greeting.new?.value).toBe('hello');
    expect(plan.outputs.id.new?.value).toBe(path.join(dir, 'a.txt'));
  });

  // A value is only as known as what it reads; surrounding text does not make it known.
  it('plans a value set from one only an apply makes as known after apply, read through another resource', async () => {
    const config = `
      resource "random_string" "s" { length = 4 }
      resource "local_file" "a" {
        path = "${path.join(dir, 'a.txt')}"
        content = "\${random_string.s.id}"
      }
      output "o" { value = "read \${local_file.a.content}" }
    `;

    const plan = await newOrchestrator().plan(config);

    expect(plan.outputs.o.new).toEqual({ value: UNKNOWN, type: types.string });
  });

  it('plans no output change when the state already has it', async () => {
    await run(withOutput('greeting'));

    const plan = await newOrchestrator().plan(withOutput('greeting'));

    expect(plan.outputs).toEqual({});
  });

  // apply reads the current directory, so the command runs from the temp one.
  it('applies a renamed output through the CLI, though no resource changes', async () => {
    await run(withOutput('greeting'));
    await fs.writeFile(path.join(dir, 'main.clay'), withOutput('message'), 'utf8');

    const cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    try {
      await createApplyCommand().parseAsync(['node', 'clay', '--yes']);
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
    }

    const state = await stored();
    expect(state.outputs).toEqual({ message: { value: 'hello', type: types.string } });
  });

  it('keeps an output that reads a failed resource at its old value', async () => {
    await run(withOutput('greeting'));

    expect(await run(failing())).toBeInstanceOf(Error);

    const state = await stored();
    expect(state.resources['local_file.a'].attributes.content).toBe('changed');
    expect(state.outputs).toEqual({ greeting: { value: 'hello', type: types.string } });
  });

  it('writes an output that reads only what was applied, though the run fails', async () => {
    const content = 'output "content" { value = local_file.a.content }';
    await run(`${withOutput('greeting')}\n${content}`);

    expect(await run(`${failing()}\n${content}`)).toBeInstanceOf(Error);

    const { outputs } = await stored();
    expect(outputs).toEqual({ greeting: { value: 'hello', type: types.string }, content: { value: 'changed', type: types.string } });
  });

  it('drops an output the configuration no longer declares, though the run fails', async () => {
    await run(withOutput('old'));

    expect(await run(failing())).toBeInstanceOf(Error);

    const { outputs } = await stored();
    expect(outputs).toEqual({});
  });

  // `early` reads nothing, so it resolves at the start; `late` is held to the plan once `a` is made.
  it('writes an output that resolved before another stops the run', async () => {
    const engine = newOrchestrator();
    const plan = await engine.plan(lateAndEarly('${local_file.a.content}'));

    await expect(drain(engine.runPlan(plan, lateAndEarly('${local_file.a.content}!')))).rejects.toThrow(
      'the plan showed late = "hello", but it now comes to "hello!". Plan again.'
    );

    const { outputs } = await stored();
    expect(outputs).toEqual({ early: { value: 'now', type: types.string } });
  });

  it('plans no output change after a failed run, against the outputs it kept', async () => {
    await run(withOutput('greeting'));
    await run(failing());

    const plan = await newOrchestrator().plan(withOutput('greeting'));

    expect(plan.outputs).toEqual({});
  });
});
