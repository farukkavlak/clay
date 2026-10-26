import { types, UNKNOWN } from '@clay/contracts';

import { LocalBackend } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { errorOf, orchestratorIn } from '../helpers';
import { start } from '../start';

const RANDOM = 'resource "random_string" "r" { length = 4 }';

/** A list that only the apply knows. */
const LIST = 'tolist(toset([length(random_string.r.result)]))';

const output = (part: string) => `${RANDOM}\noutput "o" {\n  value = "x-\${${part}}"\n}`;

describe('a value not known yet joined into a string or used as an index', () => {
  let dir: string;

  const newOrchestrator = () => orchestratorIn(dir);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-unknown-template-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['plan', (config: string) => newOrchestrator().plan(config)],
    ['validate', (config: string) => newOrchestrator().validate(config)],
  ])('is refused by %s when its type can never be joined', async (_, run) => {
    const error = await errorOf(() => run(output(LIST)));

    expect(error.message).toBe(`tolist(...) is a list and cannot be joined into a string`);
    expect(error.block).toBe('output "o"');
  });

  it('is refused when it sits beside a part that is known', async () => {
    const config = `${RANDOM}\nlocals {\n  list = ${LIST}\n}\noutput "o" {\n  value = "\${random_string.r.result}-\${local.list}"\n}`;

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('local.list is a list and cannot be joined into a string');
  });

  it.each([
    ['plan', (config: string) => newOrchestrator().plan(config)],
    ['validate', (config: string) => newOrchestrator().validate(config)],
  ])('is refused by %s as an index when its type can never be one', async (_, run) => {
    const config = `${RANDOM}\nlocals {\n  names = ["a"]\n}\noutput "o" {\n  value = local.names[${LIST}]\n}`;

    const error = await errorOf(() => run(config));

    expect(error.message).toBe('An index is a number or a string, not a list');
    expect(error.block).toBe('output "o"');
  });

  it('refuses a sensitive one as an index by its type', async () => {
    const config = `${RANDOM}\nlocals {\n  names = ["a"]\n  list  = sensitive(${LIST})\n}\noutput "o" {\n  value = local.names[local.list]\n}`;

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('An index is a number or a string, not a list');
  });

  it('is refused as a part by its type when it is sensitive', async () => {
    const config = `${RANDOM}\nlocals {\n  list = sensitive(${LIST})\n}\noutput "o" {\n  sensitive = true\n  value     = "x-\${local.list}"\n}`;

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('local.list is a list and cannot be joined into a string');
  });

  it('is refused as a known part by its type when it is sensitive', async () => {
    const config = `locals {\n  list = sensitive(["a"])\n}\noutput "o" {\n  sensitive = true\n  value     = "x-\${local.list}"\n}`;

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('local.list is a tuple and cannot be joined into a string');
  });

  it.each([
    ['a number as a part', 'x-${length(random_string.r.result)}'],
    ['a string as a part', 'x-${random_string.r.result}'],
    ['a value of no type yet as a part', 'x-${local.names[length(random_string.r.result)]}'],
  ])('is planned as %s, since it may be joined once it is known', async (_, text) => {
    const config = `${RANDOM}\nlocals {\n  names = ["a"]\n}\noutput "o" {\n  value = "${text}"\n}`;

    const { actions } = await newOrchestrator().plan(config);

    expect(actions.map((action) => action.type)).toEqual(['CREATE']);
  });

  it.each([
    ['a number', 'length(random_string.r.result)'],
    ['a string', 'random_string.r.result'],
    ['a value of no type yet', 'local.names[length(random_string.r.result)]'],
  ])('is planned as an index when it is %s', async (_, index) => {
    const config = `${RANDOM}\nlocals {\n  names = ["a"]\n  by    = { x = "a" }\n}\noutput "o" {\n  value = local.by[${index}]\n}`;

    const { actions } = await newOrchestrator().plan(config);

    expect(actions.map((action) => action.type)).toEqual(['CREATE']);
  });

  it.each([
    ['a condition', 'length(random_string.r.result) == 4 ? "a" : "b"', 'x-a'],
    ['arithmetic', 'length(random_string.r.result) + 1', 'x-5'],
    ['a comparison', 'random_string.r.result == "a"', 'x-false'],
  ])('leaves the string to the apply where %s in it is not known yet', async (_, part, expected) => {
    const config = output(part);

    const plan = await newOrchestrator().plan(config);
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;

    expect(plan.outputs.o.new).toEqual({ value: UNKNOWN, type: types.string });
    const state = await new LocalBackend(dir).read();
    expect(state.outputs?.o.value).toBe(expected);
  });

  it('keeps a sensitive part not known yet sensitive in the string', async () => {
    await expect(newOrchestrator().plan(output('sensitive(length(random_string.r.result) == 4) ? "a" : "b"'))).rejects.toThrow(
      'output "o" holds a sensitive value; write sensitive = true to export it'
    );
  });
});
