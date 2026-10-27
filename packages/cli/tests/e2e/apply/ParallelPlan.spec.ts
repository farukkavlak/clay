import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { orchestratorIn, TestEngine } from '../helpers';
import { Slow } from '../slow';
import { start } from '../start';

const blocks = (...names: string[]) => names.map((name) => `resource "slow" "${name}" {\n  name = "${name}"\n}`).join('\n');

/** A resource whose provider fails it as `mode` says. */
const failing = (name: string, mode: string) => `resource "slow" "${name}" {\n  name = "${name}"\n  mode = "${mode}"\n}`;

const twelve = Array.from({ length: 12 }, (_, index) => `r${index}`);

describe('a plan', () => {
  let dir: string;
  let provider: Slow;
  let engine: TestEngine;

  const using = (slow: Slow) => {
    provider = slow;
    engine = orchestratorIn(dir, provider);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-parallel-plan-'));
    using(new Slow(['read']));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const run = async (config: string) => {
    for await (const event of start(engine, config)) if (event.type === 'failed') throw event.error;
  };

  /** Run, and counted from nothing after. */
  const applied = async (config: string) => {
    await run(config);
    provider.most = 0;
    provider.reads = 0;
  };

  describe('refreshing', () => {
    it('reads what state holds ten at a time', async () => {
      const config = blocks(...twelve);
      await applied(config);

      const { actions } = await engine.plan(config);

      expect(provider.most).toBe(10);
      expect(actions.filter(({ type }) => type === 'NO_OP')).toHaveLength(12);
    });

    it.each([1, 3])('reads %i at a time where it is told to', async (parallelism) => {
      const config = blocks('a', 'b', 'c', 'd');
      await applied(config);

      await engine.plan(config, { parallelism });

      expect(provider.most).toBe(parallelism);
    });

    it.each([0, -1, 2.5, Number.NaN])('refuses %s before it reads anything', async (parallelism) => {
      const config = blocks('a');
      await applied(config);

      await expect(engine.plan(config, { parallelism })).rejects.toThrow(`parallelism is a whole number from 1, not ${parallelism}`);
      expect(provider.reads).toBe(0);
    });

    it('names the resource it cannot read', async () => {
      const config = `${blocks('a')}\n${failing('b', 'read fails')}`;
      await applied(config);

      await expect(engine.plan(config)).rejects.toThrow('slow.b: b fails to read');
    });

    // `a` fails last, so a refresh that reported the first failure to come would name `b`.
    it('names the first resource in state it cannot read, not the first read to fail', async () => {
      const config = `${failing('a', 'read fails late')}\n${failing('b', 'read fails')}`;
      await applied(config);

      await expect(engine.plan(config)).rejects.toThrow('slow.a: a fails to read');
    });
  });

  describe('loading schemas', () => {
    const types = twelve.map((name) => `slow_${name}`);

    it('asks for the schema of each type ten at a time', async () => {
      using(new Slow(['getSchema'], types));

      await engine.plan(types.map((type) => `resource "${type}" "x" {\n  name = "x"\n}`).join('\n'));

      expect(provider.most).toBe(10);
    });

    it('asks for the schema of each data source type ten at a time', async () => {
      using(new Slow(['getDataSourceSchema'], types));

      await engine.plan(types.map((type) => `data "${type}" "x" {\n  name = "x"\n}`).join('\n'));

      expect(provider.most).toBe(10);
    });

    // The schema of `b` fails, but only once the names of `a` are checked against its own.
    it('refuses a misspelled name of a data source before a later type it cannot load', async () => {
      using(new Slow([], ['slow', 'slow_unloadable']));
      const config = 'data "slow" "a" {\n  name = "a"\n  nmae = "a"\n}\ndata "slow_unloadable" "b" {\n  name = "b"\n}';

      await expect(engine.plan(config)).rejects.toThrow('nmae');
    });
  });

  describe('checking blocks as written', () => {
    it('asks the provider about each resource ten at a time', async () => {
      using(new Slow(['validate']));

      await engine.validate(blocks(...twelve));

      expect(provider.most).toBe(10);
    });

    it('asks the provider about each data source ten at a time', async () => {
      using(new Slow(['validateDataSource']));

      await engine.validate(twelve.map((name) => `data "slow" "${name}" {\n  name = "${name}"\n}`).join('\n'));

      expect(provider.most).toBe(10);
    });

    it('refuses the first block its provider refuses, not the first refusal to come', async () => {
      await expect(engine.validate(`${failing('a', 'validate fails late')}\n${failing('b', 'validate fails')}`)).rejects.toThrow('a fails to validate');
    });

    // `b` is refused as written before the provider has answered about `a`.
    it('refuses a block its provider refuses before a later one refused as written', async () => {
      const config = `${failing('a', 'validate fails late')}\nresource "slow" "b" {\n  name = ["x"]\n}`;

      await expect(engine.validate(config)).rejects.toThrow('a fails to validate');
    });
  });

  describe('looking for two blocks that are one thing', () => {
    it('asks the provider what each is ten at a time', async () => {
      using(new Slow(['identify']));

      await engine.plan(blocks(...twelve));

      expect(provider.most).toBe(10);
    });

    it('names the first block the provider cannot tell, not the first failure to come', async () => {
      await expect(engine.plan(`${failing('a', 'identify fails late')}\n${failing('b', 'identify fails')}`)).rejects.toThrow('a fails to identify');
    });

    it('asks about what state holds ten at a time when an apply makes a resource', async () => {
      using(new Slow(['identify']));
      await applied(blocks(...twelve));

      await run(blocks(...twelve, 'new'));

      expect(provider.most).toBe(10);
    });
  });
});
