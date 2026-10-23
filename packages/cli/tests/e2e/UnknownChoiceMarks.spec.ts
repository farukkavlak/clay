import { types } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

// Not known at plan, and false once the string is made.
const LATER = 'length(random_string.s.result) == 5';

const output = (value: string) => `resource "random_string" "s" { length = 4 }\noutput "o" {\n  value = ${value}\n}`;

const REFUSED = 'output "o" holds a sensitive value; write sensitive = true to export it';

// A choice not known at plan gives a value not known either, so a mark on only one side waits for the apply.
describe('a value a choice not known at plan makes', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  const outputs = async () => {
    const state = await new LocalBackend(dir).read();
    return Object.fromEntries(Object.entries(state.outputs ?? {}).map(([name, { value }]) => [name, value]));
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-unknown-choice-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['a condition', `${LATER} ? sensitive("a") : "b"`, 'b'],
    ['&&', `${LATER} && sensitive(true)`, false],
    ['issensitive of a condition', `issensitive(${LATER} ? sensitive("a") : "b")`, false],
    ['issensitive of && its sensitive right side decides', `issensitive(${LATER} && sensitive(false))`, false],
    ['issensitive of && its sensitive left side decides', `issensitive(sensitive(${LATER}) && false)`, true],
    ['issensitive of || its sensitive right side decides', `issensitive(${LATER} || sensitive(true))`, true],
    ['issensitive of && with a known sensitive left side and a right side that decides', `issensitive(sensitive(true) && ${LATER})`, false],
    ['issensitive of && with only its left side sensitive, both not known', `issensitive(sensitive(length(random_string.s.result) == 4) && ${LATER})`, false],
    ['issensitive of || with a known sensitive left side and a right side that decides', `issensitive(sensitive(false) || !(${LATER}))`, false],
    ['issensitive of || with only its left side sensitive, both not known', `issensitive(sensitive(${LATER}) || !(${LATER}))`, false],
  ])('is sensitive only where the side the apply takes is, for %s', async (_, value, expected) => {
    await apply(output(value));

    expect(await outputs()).toEqual({ o: expected });
  });

  it.each([
    ['a condition', `!(${LATER}) ? sensitive("a") : "b"`],
    ['||', `${LATER} || sensitive(false)`],
  ])('refuses at the apply an output the side it takes makes sensitive, for %s', async (_, value) => {
    await newOrchestrator().plan(output(value));

    await expect(apply(output(value))).rejects.toThrow(REFUSED);
  });

  it('knows at plan what && gives where its right side decides and neither side is sensitive', async () => {
    const plan = await newOrchestrator().plan(output(`${LATER} && false`));

    expect(plan.outputs.o.new).toEqual({ value: false, type: types.bool });
  });

  it.each([
    ['both sides of a condition', `${LATER} ? sensitive("a") : sensitive("b")`],
    ['a sensitive condition', `sensitive(${LATER}) ? "a" : "b"`],
    ['a sensitive left side of &&', `sensitive(${LATER}) && true`],
    ['both sides of && where its right side decides', `sensitive(${LATER}) && sensitive(false)`],
    ['both sides of && not known', `sensitive(length(random_string.s.result) == 4) && sensitive(${LATER})`],
  ])('refuses at plan an output sensitive whichever side the apply takes, for %s', async (_, value) => {
    await expect(newOrchestrator().plan(output(value))).rejects.toThrow(REFUSED);
  });
});
