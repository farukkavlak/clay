import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The tests compile to CommonJS, which has no import.meta.dirname.
// eslint-disable-next-line unicorn/prefer-module
const clay = path.resolve(__dirname, '../../bin/clay.js');

const secret = (value: string, flag = '\n  sensitive = true') => `output "password" {\n  value = "${value}"${flag}\n}\noutput "plain" { value = "seen" }`;

const collection = (value: string) => `output "password" {\n  value = ${value}\n  sensitive = true\n}`;

const typed = (value: string, type: string, flag = 'sensitive = true') =>
  `resource "random_string" "s" { length = 8 }\noutput "password" {\n  value = ${value}\n  type = ${type}\n  ${flag}\n}`;

describe('a sensitive output', () => {
  let dir: string;

  const clayIn = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)('node', [clay, ...args], { cwd: dir });
    return stripVTControlCharacters(stdout);
  };

  const written = async (config: string, ...args: string[]) => {
    await fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');
    return clayIn(...args);
  };

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-sensitive-'));
    await clayIn('init');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is hidden in what plan and apply print, beside one that is not', async () => {
    const planned = await written(secret('s3cret'), 'plan');
    const applied = await clayIn('apply', '--yes');

    expect(planned).toContain('+ password = <sensitive>\n  + plain = "seen"');
    expect(applied).toContain('Outputs:\n  password = <sensitive>\n  plain = "seen"');
    expect(planned + applied).not.toContain('s3cret');
  });

  it('is hidden by clay output, which reads only the state, and given with its flag as JSON', async () => {
    await written(secret('s3cret'), 'apply', '--yes');

    const read = await clayIn('output');
    const json = JSON.parse(await clayIn('output', '--json')) as Record<string, unknown>;

    expect(read).toContain('password = <sensitive>\nplain = "seen"');
    expect(read).not.toContain('s3cret');
    expect(json).toEqual({ password: { value: 's3cret', type: { kind: 'string' }, sensitive: true }, plain: { value: 'seen', type: { kind: 'string' } } });
  });

  it('is hidden when a saved plan is shown before it runs', async () => {
    await written(secret('s3cret'), 'plan', '--out', 'p.plan');

    const applied = await clayIn('apply', 'p.plan');

    expect(applied).toContain('+ password = <sensitive>');
    expect(applied).not.toContain('s3cret');
  });

  it('shows that its value changes, and neither value', async () => {
    await written(secret('s3cret'), 'apply', '--yes');

    const planned = await written(secret('n3w'), 'plan');

    expect(planned).toContain('~ password = <sensitive>');
    expect(planned).not.toMatch(/s3cret|n3w/);
  });

  it('stays hidden in the plan that takes the flag off, and is printed once that is applied', async () => {
    await written(secret('s3cret'), 'apply', '--yes');

    const planned = await written(secret('s3cret', ''), 'plan');
    const applied = await clayIn('apply', '--yes');

    expect(planned).toContain('~ password = <sensitive>');
    expect(planned).not.toContain('s3cret');
    expect(applied).toContain('password = "s3cret"');
  });

  it('is hidden in the plan that puts the flag on a value already printed', async () => {
    await written(secret('s3cret', ''), 'apply', '--yes');

    const planned = await written(secret('s3cret'), 'plan');

    expect(planned).toContain('~ password = <sensitive>');
    expect(planned).not.toContain('s3cret');
  });

  it.each([
    ['showed', '', 'the plan showed password = <sensitive>, but it now comes to another value. Plan again.'],
    ['left as it was', 'apply', 'the plan left password = <sensitive> as it was, but it now comes to another value. Plan again.'],
  ])('is named without its value where a plan that %s it is run on another', async (_, first, message) => {
    if (first) await written(secret('s3cret'), first, '--yes');
    const saved = await newOrchestrator().plan(`${secret('s3cret')}\nresource "null_resource" "n" {}`);

    const run = async () => {
      for await (const event of newOrchestrator().runPlan(saved, `${secret('n3w')}\nresource "null_resource" "n" {}`)) if (event.type === 'failed') throw event.error;
    };

    await expect(run()).rejects.toThrow(message);
  });

  it.each([
    [
      'hid it is run with a configuration that prints it',
      secret('s3cret'),
      secret('s3cret', ''),
      'the plan showed password as sensitive, but it is not sensitive now. Plan again.',
    ],
    [
      'printed it is run with a configuration that hides it',
      secret('s3cret', ''),
      secret('s3cret'),
      'the plan showed password as not sensitive, but it is sensitive now. Plan again.',
    ],
  ])('stops the run where a plan that %s', async (_, plannedWith, runWith, message) => {
    const saved = await newOrchestrator().plan(plannedWith);

    const run = async () => {
      for await (const event of newOrchestrator().runPlan(saved, runWith)) if (event.type === 'failed') throw event.error;
    };

    await expect(run()).rejects.toThrow(message);
    await expect(clayIn('output')).resolves.toContain('No outputs found in state.');
  });

  it('is named without its value where only its type is not the one the plan showed', async () => {
    const saved = await newOrchestrator().plan(collection('toset(["a", "b"])'));

    const run = async () => {
      for await (const event of newOrchestrator().runPlan(saved, collection('["a", "b"]'))) if (event.type === 'failed') throw event.error;
    };

    await expect(run()).rejects.toThrow('the plan showed password = <sensitive>, but it now comes to another type. Plan again.');
  });

  describe('of a type its value does not fit', () => {
    it('is refused at apply without the value a resource made', async () => {
      const applied = await written(typed('random_string.s.result', 'number'), 'apply', '--yes').catch((error: { stderr: string }) => stripVTControlCharacters(error.stderr));
      const made = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as { resources: Record<string, { attributes: { result: string } }> };

      expect(applied).toContain('Apply failed: password is not a number, or is one out of range');
      expect(applied).not.toContain(made.resources['random_string.s'].attributes.result);
    });

    it.each([
      ['a number', '"s3cret"', 'number', 'password is not a number, or is one out of range'],
      ['a boolean inside it', '{ a = "s3cret" }', 'object({ a = bool })', 'password["a"] is not a boolean, which is "true" or "false"'],
    ])('is refused by validate without the value, where it takes %s', async (_, value, type, message) => {
      await expect(newOrchestrator().validate(typed(value, type))).rejects.toThrow(message);
    });

    it('is refused with the value where it is not sensitive', async () => {
      await expect(newOrchestrator().validate(typed('"s3cret"', 'number', ''))).rejects.toThrow('password: "s3cret" is not a number');
    });
  });
});
