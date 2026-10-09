import { UNKNOWN } from '@clay/contracts';
import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { ConfigError } from '@clay/parser';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const refusal = async (work: Promise<unknown>): Promise<ConfigError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof ConfigError) return error;

    throw error;
  }

  throw new Error('Expected the configuration to be refused');
};

const unused = (content: string) => `locals { names = ["a", "b"] }\nresource "local_file" "f" {\n  count   = 0\n  path    = "x"\n  content = ${content}\n}`;

describe('locals', () => {
  let dir: string;

  const newOrchestrator = () => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    return engine;
  };

  const plannedOutputs = async (config: string) => {
    const { outputs } = await newOrchestrator().plan(config);
    return Object.fromEntries(Object.entries(outputs).map(([name, change]) => [name, change.new?.value]));
  };

  const apply = async (config: string): Promise<Record<string, unknown>> => {
    const engine = newOrchestrator();
    let outputs: Record<string, unknown> = {};

    for await (const event of engine.runPlan(await engine.plan(config), config)) {
      if (event.type === 'failed') throw event.error;
      if (event.type === 'done') outputs = Object.fromEntries(Object.entries(event.outputs).map(([name, output]) => [name, output.value]));
    }
    return outputs;
  };

  const validate = (config: string) => newOrchestrator().validate(config);

  const writeModule = async (name: string, content: string) => {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(path.join(dir, name, 'main.clay'), content, 'utf8');
  };

  // An absolute path, since the provider reads a relative one from where the test runs.
  const writes = (content: string) => `resource "local_file" "a" {\n  path    = "${dir}/a.txt"\n  content = "${content}"\n}`;

  const reads = (content: string) =>
    `${writes(content)}\nlocals { made = local_file.a.path }\ndata "local_file" "read" { path = local.made }\noutput "read" { value = data.local_file.read.content }`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-locals-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reads a local by its name, and one local from another written after it in another block', async () => {
    const config = `
      variable "prefix" { default = "app" }
      locals { names = [local.name, "b"] }
      locals { name = "\${var.prefix}-x" }
      output "name" { value = local.name }
      output "second" { value = local.names[1] }
      output "names" { value = local.names }
    `;

    expect(await plannedOutputs(config)).toEqual({ name: 'app-x', second: 'b', names: ['app-x', 'b'] });
    expect(await apply(config)).toEqual({ name: 'app-x', second: 'b', names: ['app-x', 'b'] });
  });

  it('works a local out for each instance of its module', async () => {
    await writeModule('m', 'variable "in" {}\nlocals { twice = "${var.in}-${var.in}" }\noutput "o" { value = local.twice }');
    const config = 'module "m" {\n  count  = 2\n  source = "./m"\n  in     = "i${count.index}"\n}\noutput "all" { value = [for m in module.m : m.o] }';

    expect(await apply(config)).toEqual({ all: ['i0-i0', 'i1-i1'] });
  });

  it('gives a module input a local of the caller', async () => {
    await writeModule('m', 'variable "in" {}\noutput "o" { value = var.in }');

    expect(await apply('locals { name = "x" }\nmodule "m" {\n  source = "./m"\n  in     = local.name\n}\noutput "o" { value = module.m.o }')).toEqual({ o: 'x' });
  });

  it('makes the instances a count read from a local gives', async () => {
    const config = `locals { names = ["a", "b"] }\nresource "local_file" "f" {\n  count   = length(local.names)\n  path    = "${dir}/f\${count.index}.txt"\n  content = local.names[0]\n}`;

    await apply(config);

    expect(await fs.readFile(path.join(dir, 'f1.txt'), 'utf8')).toBe('a');
  });

  it('refuses a local that is not declared, where it is read', async () => {
    const error = await refusal(validate('locals { a = 1 }\noutput "o" {\n  value = local.nope\n}'));

    expect(error.message).toBe('local "nope" is not defined');
    expect(error.position).toMatchObject({ line: 3, column: 11 });
    expect(error.block).toBe('output "o"');
  });

  it('keeps a local to its module: neither the caller nor the module reads the other', async () => {
    await writeModule('own', 'locals { inner = 1 }\noutput "o" { value = 1 }');
    await writeModule('reads', 'output "o" { value = local.outer }');

    const inCaller = await refusal(validate('module "m" { source = "./own" }\noutput "o" { value = local.inner }'));
    const inModule = await refusal(validate('locals { outer = 1 }\nmodule "m" { source = "./reads" }'));

    expect(inCaller.message).toBe('local "inner" is not defined');
    expect(inModule.message).toBe('local "outer" is not defined');
    expect(inModule.module).toBe('module.m');
  });

  it('refuses locals that read each other, and one that reads itself', async () => {
    const two = await refusal(validate('locals {\n  a = local.b\n  b = local.a\n}'));
    const one = await refusal(validate('locals { a = [local.a] }'));

    expect(two.message).toBe('Dependency cycle detected: local.a -> local.b -> local.a');
    expect(two.block).toBe('local "a"');
    expect(one.message).toBe('Dependency cycle detected: local.a -> local.a');
  });

  it('refuses count.index in a local, which belongs to no instance', async () => {
    const error = await refusal(validate('locals { i = count.index }'));

    expect(error.message).toBe('count.index is only known inside a resource, a data source or a module call that has count');
    expect(error.block).toBe('local "i"');
  });

  it('reports a mistake in a local nothing reads, in a module that makes no instance', async () => {
    await writeModule('m', 'locals {\n  unread = tolist([1, true])\n}');

    const error = await refusal(validate('module "m" {\n  count  = 0\n  source = "./m"\n}'));

    expect(error.position).toMatchObject({ file: 'm/main.clay', line: 2 });
    expect(error.block).toBe('local "unread"');
  });

  it('reports a local that fails at plan at the local, in the instance of its module', async () => {
    await writeModule('m', 'variable "names" {\n  type = list(string)\n}\nlocals {\n  third = var.names[2]\n}');

    const error = await refusal(newOrchestrator().plan('module "m" {\n  count  = 1\n  source = "./m"\n  names  = ["a"]\n}'));

    expect(error.message).toBe('var.names has no item [2]: it holds 1');
    expect(error.position).toMatchObject({ file: 'm/main.clay', line: 5 });
    expect(error.block).toBe('local "third"');
    expect(error.module).toBe('module.m[0]');
  });

  it('reports a local that fails at apply at the local, and keeps what was made before it', async () => {
    const config = 'resource "random_string" "s" { length = 3 }\nlocals {\n  bad = random_string.s.result.nope\n}';

    const error = await refusal(apply(config));
    const state = await new StateManager(new LocalBackend(dir)).read();

    expect(error.message).toBe('random_string.s.result is a string and cannot be read into');
    expect(error.block).toBe('local "bad"');
    expect(Object.keys(state.resources)).toEqual(['random_string.s']);
  });

  // Each step reads the one before it twice, so reading a local again for every reader would take 2^40 reads.
  it('reads a local as written once, however many read it', async () => {
    const chain = Array.from({ length: 40 }, (_, step) => `  l${step + 1} = [local.l${step}[0], local.l${step}[0]]`).join('\n');

    await expect(validate(`locals {\n  l0 = ["a"]\n${chain}\n}\n${unused('local.l40[0]')}`)).resolves.toBeUndefined();
  });

  describe('not known until the apply', () => {
    it('is planned as unknown, and what reads it with it', async () => {
      const config =
        'resource "random_string" "s" { length = 4 }\nlocals { both = ["known", random_string.s.result] }\noutput "both" { value = local.both }\noutput "first" { value = local.both[0] }';

      expect(await plannedOutputs(config)).toEqual({ both: ['known', UNKNOWN], first: 'known' });
    });

    it('is worked out again at apply, after the resource it reads is made', async () => {
      const config =
        'resource "random_string" "s" { length = 4 }\nlocals { made = random_string.s.result }\noutput "made" { value = local.made }\noutput "direct" { value = random_string.s.result }';

      const outputs = await apply(config);

      expect(outputs.made).toMatch(/^.{4}$/);
      expect(outputs.made).toBe(outputs.direct);
    });

    it('leaves a data source that reads a pending resource through it for the apply', async () => {
      const plan = await newOrchestrator().plan(reads('new'));

      expect(plan.readAtApply).toEqual(['data.local_file.read']);
      expect(await apply(reads('new'))).toEqual({ read: 'new' });
    });

    it('gives that data source what the apply wrote, not what the file held before', async () => {
      await apply(reads('old'));

      expect(await apply(reads('new'))).toEqual({ read: 'new' });
    });

    it('is accepted by validate as a count, which only a plan needs to know', async () => {
      const config = `${reads('ab')}\nlocals { size = length(data.local_file.read.content) }\nresource "null_resource" "n" { count = local.size }`;

      await expect(validate(config)).resolves.toBeUndefined();
      await expect(newOrchestrator().plan(config)).rejects.toThrow('count must be known when planning');
    });
  });

  describe('read as written, in a block that makes no instance', () => {
    it('has the type its value has', async () => {
      const error = await refusal(validate(unused('local.names')));

      expect(error.message).toBe('content is a tuple, where local_file takes a string');
      expect(error.block).toBe('resource "local_file" "f"');
    });

    it('is read into as far as it is known', async () => {
      await expect(validate(unused('local.names[1]'))).resolves.toBeUndefined();
      const error = await refusal(validate(unused('local.names[2]')));

      expect(error.message).toBe('local.names has no item [2]: it holds 2');
    });

    it('takes the type of what it reads, through another local', async () => {
      const config =
        'variable "tags" {\n  type    = map(string)\n  default = {}\n}\nlocals {\n  outer = local.inner\n  inner = var.tags\n}\nresource "local_file" "f" {\n  count   = 0\n  path    = "x"\n  content = local.outer\n}';

      const error = await refusal(validate(config));

      expect(error.message).toBe('content is a map, where local_file takes a string');
    });

    it('reports a mistake in a local at the local, not at what reads it', async () => {
      await writeModule('m', 'locals {\n  bad = tolist([1, true])\n}\nresource "local_file" "f" {\n  path    = "x"\n  content = local.bad\n}');

      const error = await refusal(validate('module "m" {\n  count  = 0\n  source = "./m"\n}'));

      expect(error.position).toMatchObject({ file: 'm/main.clay', line: 2 });
      expect(error.block).toBe('local "bad"');
      expect(error.module).toBe('module.m');
    });
  });
});
