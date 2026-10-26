import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorOf, orchestratorIn, placeOf } from '../helpers';

const RANDOM = 'resource "random_string" "r" { length = 8 }';

describe('a step into a value not known yet', () => {
  let dir: string;

  const newOrchestrator = () => orchestratorIn(dir);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-step-into-unknown-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const file = (extra: string) => () => `${RANDOM}\nresource "local_file" "f" {\n  ${extra}\n  path = "${path.join(dir, 'f.txt')}"\n  content = random_string.r.result.nope\n}`;

  it.each([
    ['a resource', file(''), 'resource "local_file" "f"'],
    ['a resource that makes no instance', file('count = 0'), 'resource "local_file" "f"'],
    ['a root output', () => `${RANDOM}\noutput "o" {\n  value = random_string.r.result.nope\n}`, 'output "o"'],
    ['a local', () => `${RANDOM}\nlocals {\n  bad = random_string.r.result.nope\n}\noutput "o" {\n  value = local.bad\n}`, 'local "bad"'],
  ])('is refused at plan in %s, before anything is made', async (_, written, block) => {
    const config = written();
    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('random_string.r.result is a string and cannot be read into');
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, 'random_string.r.result.nope') });
    expect(error.block).toBe(block);
  });

  it('is refused at plan when a module variable holds the whole value', async () => {
    await fs.mkdir(path.join(dir, 'm'));
    await fs.writeFile(path.join(dir, 'm', 'main.clay'), 'variable "v" {}\noutput "o" {\n  value = var.v.nope\n}', 'utf8');
    const config = `${RANDOM}\nmodule "m" {\n  source = "./m"\n  v      = random_string.r.result\n}`;

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('var.v is a string and cannot be read into');
  });

  // `validate` reads no data source, so what it reads is not known yet.
  it('is refused by validate in what a data source reads', async () => {
    const config = 'data "local_file" "f" {\n  path = "f.txt"\n}\noutput "o" {\n  value = data.local_file.f.content.nope\n}';

    const error = await errorOf(() => newOrchestrator().validate(config));

    expect(error.message).toBe('data.local_file.f.content is a string and cannot be read into');
    expect(error.position).toEqual({ file: 'main.clay', ...placeOf(config, 'data.local_file.f.content.nope') });
  });

  it('is refused in a for over a list whose items are strings', async () => {
    const config = `${RANDOM}\noutput "o" {\n  value = [for v in tolist(toset([random_string.r.result])) : v.nope]\n}`;

    const error = await errorOf(() => newOrchestrator().plan(config));

    expect(error.message).toBe('v is a string and cannot be read into');
  });
});
