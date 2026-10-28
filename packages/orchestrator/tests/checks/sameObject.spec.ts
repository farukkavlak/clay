import { CreateRequest, Identity, planFromSchema, PlannedChange, PlanRequest, Provider, Schema, State, types, UpdateRequest } from '@clay/contracts';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apply } from '../apply';
import { engineOn, TestEngine } from '../engine';

/** A thing named by `place` in any case, which a change of `label` replaces. */
class PlacedProvider implements Provider {
  readonly resources = ['placed'];
  /** The start of each place that can no longer be told, as a disk changed under a run. */
  lost = 'lost';
  readonly dataSources: string[] = [];

  async getSchema(): Promise<Schema> {
    return {
      id: { type: types.string, computed: true, kept: true },
      place: { type: types.string, required: true },
      label: { type: types.string, required: true, forceNew: true },
    };
  }

  async plan(type: string, request: PlanRequest): Promise<PlannedChange> {
    return planFromSchema(await this.getSchema(), request);
  }

  async validate(): Promise<void> {}

  async read(_type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return prior;
  }

  async create(_type: string, { config }: CreateRequest): Promise<Record<string, unknown>> {
    return { ...config, id: String(config.label) };
  }

  async update(_type: string, { prior, config }: UpdateRequest): Promise<Record<string, unknown>> {
    return { ...config, id: prior.id };
  }

  async delete(): Promise<void> {}

  async identify(_type: string, values: Record<string, unknown>): Promise<Identity | undefined> {
    if (String(values.place).startsWith(this.lost)) throw new Error('the place is lost');
    return typeof values.place === 'string' ? { key: values.place.toLowerCase(), name: `the place ${values.place}` } : undefined;
  }

  async getDataSourceSchema(): Promise<Schema> {
    return {};
  }

  async validateDataSource(): Promise<void> {}

  async readDataSource(): Promise<Record<string, unknown>> {
    return {};
  }
}

/** `name` at `place`, labelled after its name. */
const named = (name: string, place: string) => `resource "placed" "${name}" {\n  place = "${place}"\n  label = "${name}1"\n}\n`;

const placedAt = (place: string) => `resource "placed" "a" {\n  place = "${place}"\n  label = "a1"\n}\n`;

const placed = (label: string, cbd: boolean) =>
  `resource "placed" "a" {\n  place = "p"\n  label = "${label}"\n${cbd ? '  lifecycle {\n    create_before_destroy = true\n  }\n' : ''}}\n`;

describe('a replace whose new object is its old one', () => {
  let dir: string;
  let orchestrator: TestEngine;
  let provider: PlacedProvider;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'same-object-'));
    orchestrator = engineOn(new StateManager(new LocalBackend(dir)));
    provider = new PlacedProvider();
    orchestrator.registerProvider(provider);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is refused with create_before_destroy, whose destroy would remove the new one', async () => {
    await apply(orchestrator, placed('one', true));

    await expect(orchestrator.plan(placed('two', true))).rejects.toThrow('placed.a makes its new object before it destroys the old one, but both are the place p');
  });

  it('is planned without it, since the old one goes first', async () => {
    await apply(orchestrator, placed('one', false));

    const { actions } = await orchestrator.plan(placed('two', false));

    expect(actions.map((action) => action.type)).toEqual(['REPLACE']);
  });

  it('refuses two objects whose keys are one, named as the second spells it', async () => {
    const config = 'resource "placed" "a" {\n  place = "p"\n  label = "a1"\n}\nresource "placed" "b" {\n  place = "P"\n  label = "b1"\n}\n';

    await expect(orchestrator.plan(config)).rejects.toThrow('placed.b and placed.a are both the place P');
  });

  it('refuses at apply one of two objects made together whose keys are one', async () => {
    const config =
      'resource "placed" "c" {\n  place = "c"\n  label = "p"\n}\nresource "placed" "d" {\n  place = "d"\n  label = "P"\n}\n' +
      'resource "placed" "a" {\n  place = placed.c.id\n  label = "a1"\n}\nresource "placed" "b" {\n  place = placed.d.id\n  label = "b1"\n}\n';

    await expect(apply(orchestrator, config)).rejects.toThrow(/^placed\.(a and placed\.b|b and placed\.a) are both the place [pP],/);
  });

  it('refuses at apply an object whose key one in the state has', async () => {
    const kept = 'resource "placed" "a" {\n  place = "p"\n  label = "a1"\n}\n';
    await apply(orchestrator, kept);
    const config = `${kept}resource "placed" "c" {\n  place = "c"\n  label = "P"\n}\nresource "placed" "b" {\n  place = placed.c.id\n  label = "b1"\n}\n`;

    await expect(apply(orchestrator, config)).rejects.toThrow('placed.b and placed.a are both the place P');
  });

  it('refuses at apply an update onto what another object is, where only the apply knows it', async () => {
    const before = 'resource "placed" "a" {\n  place = "one"\n  label = "a1"\n}\nresource "placed" "b" {\n  place = "x"\n  label = "b1"\n}\n';
    await apply(orchestrator, before);
    const after = before.replace('place = "x"', 'place = placed.c.id') + 'resource "placed" "c" {\n  place = "c"\n  label = "one"\n}\n';

    await expect(apply(orchestrator, after)).rejects.toThrow('placed.b and placed.a are both the place one');
  });

  it('names an object in the state by its address where what it is cannot be told', async () => {
    await apply(orchestrator, 'resource "placed" "a" {\n  place = "x"\n  label = "a1"\n}\n');
    const state = JSON.parse(await fs.readFile(path.join(dir, 'clay.state.json'), 'utf8')) as State;
    state.resources['placed.a'].attributes.place = 'lost';
    await fs.writeFile(path.join(dir, 'clay.state.json'), JSON.stringify(state), 'utf8');

    await expect(orchestrator.plan('')).rejects.toThrow('placed.a: the place is lost');
  });

  // The run reports a failure by its action, which names it.
  it('fails a create unnamed, where only the apply finds its place cannot be told', async () => {
    const config = 'resource "placed" "c" {\n  place = "c"\n  label = "lost"\n}\nresource "placed" "b" {\n  place = placed.c.id\n  label = "b1"\n}\n';

    await expect(apply(orchestrator, config)).rejects.toThrow(/^the place is lost$/);
  });

  it('names an object in the state by its address where the apply can no longer tell what it is', async () => {
    const kept = 'resource "placed" "a" {\n  place = "x"\n  label = "a1"\n}\n';
    await apply(orchestrator, kept);
    const config = `${kept}resource "placed" "c" {\n  place = "c"\n  label = "c1"\n}\n`;
    const planned = await orchestrator.plan(config);
    provider.lost = 'x';

    const run = async () => {
      for await (const event of orchestrator.runPlan(planned, config)) if (event.type === 'failed') throw event.error;
    };

    await expect(run()).rejects.toThrow('placed.a: the place is lost');
  });

  // The move puts `placed.y` after `placed.z` among what the run holds.
  it('names the first object in address order where the apply can tell what none is', async () => {
    await apply(orchestrator, named('a', 'x1') + named('z', 'x2'));
    const config = `${named('y', 'x1').replace('y1', 'a1')}moved {\n  from = placed.a\n  to   = placed.y\n}\n${named('z', 'x2')}${named('c', 'c')}`;
    const planned = await orchestrator.plan(config);
    provider.lost = 'x';

    const run = async () => {
      for await (const event of orchestrator.runPlan(planned, config)) if (event.type === 'failed') throw event.error;
    };

    await expect(run()).rejects.toThrow('placed.y: the place is lost');
  });

  it('fails an update unnamed, where the apply can no longer tell what its own old object is', async () => {
    await apply(orchestrator, placedAt('x'));
    const planned = await orchestrator.plan(placedAt('y'));
    provider.lost = 'x';

    const run = async () => {
      for await (const event of orchestrator.runPlan(planned, placedAt('y'))) if (event.type === 'failed') throw event.error;
    };

    await expect(run()).rejects.toThrow(/^the place is lost$/);
  });
});
