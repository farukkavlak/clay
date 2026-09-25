import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { parsePlanFile, serializePlan } from '@clay/planner';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

// 2^53 + 1: the first whole number a JavaScript number cannot hold.
const PAST_2_53 = '9007199254740993';
const LARGE = '12345678901234567890';

describe('a number past what JavaScript holds exactly', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const apply = async (config: string) => {
    for await (const event of start(newOrchestrator(), config)) if (event.type === 'failed') throw event.error;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-exact-numbers-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is written into state as it was written in the configuration', async () => {
    await apply(`resource "null_resource" "a" { triggers = { id = ${LARGE}, next = ${PAST_2_53} } }`);

    const written = await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8');

    expect(written).toContain(`"id": ${LARGE}`);
    expect(written).toContain(`"next": ${PAST_2_53}`);
  });

  // Read back from state, a number has to meet the configuration's as the same value, or every plan would change it again.
  it('plans no change once applied, small or large', async () => {
    const config = `
      resource "null_resource" "a" { triggers = { id = ${LARGE}, count = 3, ratio = 007 } }
      resource "random_string" "pw" { length = 8 }
    `;
    await apply(config);

    const { actions } = await newOrchestrator().plan(config);

    expect(actions.map((action) => action.type)).toEqual(['NO_OP', 'NO_OP']);
  });

  it('plans a change for a number JavaScript would round to the one in state', async () => {
    await apply(`resource "null_resource" "a" { triggers = { id = 9007199254740992 } }`);

    const { actions } = await newOrchestrator().plan(`resource "null_resource" "a" { triggers = { id = ${PAST_2_53} } }`);

    expect(actions.map((action) => action.type)).toEqual(['UPDATE']);
  });

  // -0.10000000000000000001 is -0.1 to JavaScript; state has to keep every digit.
  it('keeps a negative decimal as it was written, and plans no change for it once applied', async () => {
    const config = `resource "null_resource" "a" { triggers = { d = -0.10000000000000000001, e = 2.5e-3 } }`;
    await apply(config);

    const written = await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8');
    const { actions } = await newOrchestrator().plan(config);

    expect(written).toContain('"d": -0.10000000000000000001');
    expect(written).toContain('"e": 0.0025');
    expect(actions.map((action) => action.type)).toEqual(['NO_OP']);
  });

  it('is joined into a string as it was written', async () => {
    await apply(`
      resource "local_file" "a" { path = "${path.join(dir, 'a.txt')}" content = "id \${var.id}" }
      variable "id" { default = ${LARGE} }
    `);

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe(`id ${LARGE}`);
  });

  it('comes back from a saved plan as it was written', async () => {
    const config = `output "id" { value = ${LARGE} }`;

    const saved = parsePlanFile(serializePlan(await newOrchestrator().plan(config), config, {}), 'plan.json');

    expect(String(saved.outputs.id.new)).toBe(LARGE);
  });
});
