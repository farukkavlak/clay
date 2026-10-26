import { UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DB = `
  resource "random_string" "s" { length = 8 }
  output "password" {
    value     = "hunter2"
    sensitive = true
  }
  output "made" {
    value     = random_string.s.result
    sensitive = true
  }
  output "conn" {
    value     = { name = "app", password = "hunter2" }
    sensitive = true
  }
`;

const REFUSED = 'output "probe" holds a sensitive value; write sensitive = true to export it';

const probe = (value: string, flag = '') => `
  resource "random_string" "r" { length = 8 }
  module "db" { source = "./db" }
  locals { part = { name = "app", password = module.db.password } }
  output "probe" {
    value = ${value}${flag}
  }
`;

describe('the functions sensitive, nonsensitive and issensitive', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const planned = async (value: string, flag = '') => {
    const { outputs } = await newOrchestrator().plan(probe(value, flag));

    return outputs.probe.new;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-sensitive-functions-'));
    await fs.mkdir(path.join(dir, 'db'));
    await fs.writeFile(path.join(dir, 'db', 'main.clay'), DB, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['a plain string', 'sensitive("abc")'],
    ['an object with one sensitive part', 'sensitive(local.part)'],
    ['a value known only after apply', 'sensitive(random_string.r.result)'],
  ])('sensitive marks %s, so a root output must say so', async (_, value) => {
    await expect(newOrchestrator().plan(probe(value))).rejects.toThrow(REFUSED);
    await expect(newOrchestrator().validate(probe(value))).rejects.toThrow(REFUSED);
  });

  it('sensitive gives a value that a flagged root output exports, marked', async () => {
    expect(await planned('sensitive("abc")', '\n    sensitive = true')).toMatchObject({ value: 'abc', sensitive: true });
  });

  it.each([
    ['a sensitive string', 'nonsensitive(module.db.password)', 'hunter2'],
    ['an object sensitive as a whole', 'nonsensitive(module.db.conn)', { name: 'app', password: 'hunter2' }],
    ['an object with one sensitive part', 'nonsensitive(local.part)', { name: 'app', password: 'hunter2' }],
    ['a value that was never sensitive', 'nonsensitive("abc")', 'abc'],
  ])('nonsensitive takes the marks off %s', async (_, value, expected) => {
    expect(await planned(value)).toMatchObject({ value: expected });
  });

  it('nonsensitive on a value known only after apply lets a root output export it', async () => {
    expect(await planned('nonsensitive(module.db.made)')).not.toHaveProperty('sensitive');
  });

  it.each([
    ['a sensitive value', 'issensitive(module.db.password)', true],
    ['a value with one sensitive part', 'issensitive(local.part)', true],
    ['a sensitive value known only after apply', 'issensitive(module.db.made)', true],
    ['a plain value', 'issensitive("abc")', false],
    ['a plain part of a sensitive object', 'issensitive(local.part.name)', false],
    ['the value nonsensitive gave', 'issensitive(nonsensitive(module.db.password))', false],
  ])('issensitive tells it of %s', async (_, value, expected) => {
    expect(await planned(value)).toMatchObject({ value: expected });
  });

  it.each([
    ['a plain value known only after apply', 'issensitive(random_string.r.result)'],
    ['a known value with a plain part known only after apply', 'issensitive({ a = random_string.r.result, b = "x" })'],
  ])('issensitive of %s is not known yet', async (_, value) => {
    expect(await planned(value)).toMatchObject({ value: UNKNOWN });
  });
});

describe('a sensitive variable', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const probed = async (config: string) => {
    const { outputs } = await newOrchestrator().plan(config);

    return outputs.probe.new;
  };

  const writeModule = async (name: string, content: string) => {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(path.join(dir, name, 'main.clay'), content, 'utf8');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-sensitive-variable-'));
    await writeModule('echo', 'variable "v" {\n  type = string\n  sensitive = true\n}\noutput "v" { value = var.v }');
    await writeModule('plain', 'variable "v" { type = string }\noutput "v" { value = var.v }');
    await writeModule('count', 'variable "n" {\n  type = number\n  sensitive = true\n}\noutput "n" { value = var.n }');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('marks the default it falls back to', async () => {
    const config = 'variable "token" {\n  default = "abc"\n  sensitive = true\n}\noutput "probe" { value = var.token }';

    await expect(newOrchestrator().plan(config)).rejects.toThrow(REFUSED);
    await expect(newOrchestrator().validate(config)).rejects.toThrow(REFUSED);
  });

  it('marks the value a module is given, and reaches an output that says so', async () => {
    const config = 'module "echo" {\n  source = "./echo"\n  v = "abc"\n}\noutput "probe" {\n  value = module.echo.v\n  sensitive = true\n}';

    expect(await probed(config)).toMatchObject({ value: 'abc', sensitive: true });
  });

  it('marks the value in a root output that does not say so', async () => {
    const config = 'module "echo" {\n  source = "./echo"\n  v = "abc"\n}\noutput "probe" { value = module.echo.v }';

    await expect(newOrchestrator().plan(config)).rejects.toThrow(REFUSED);
  });

  it('marks nothing of a variable that does not say so', async () => {
    const config = 'module "plain" {\n  source = "./plain"\n  v = "abc"\n}\noutput "probe" { value = module.plain.v }';

    expect(await probed(config)).toMatchObject({ value: 'abc' });
  });

  it('shows nothing of a value its type refuses', async () => {
    const config = 'module "count" {\n  source = "./count"\n  n = "hunter2"\n}';

    const error = await newOrchestrator()
      .plan(config)
      .catch((error_: Error) => error_);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('(sensitive value)');
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('marks a value known only after apply', async () => {
    const config = 'resource "random_string" "r" { length = 8 }\nmodule "echo" {\n  source = "./echo"\n  v = random_string.r.result\n}\noutput "probe" { value = module.echo.v }';

    await expect(newOrchestrator().plan(config)).rejects.toThrow(REFUSED);
  });

  it('is refused when the flag is not true', async () => {
    const config = 'variable "token" {\n  default = "abc"\n  sensitive = "yes"\n}';

    await expect(newOrchestrator().plan(config)).rejects.toThrow('sensitive is true or false.');
  });
});
