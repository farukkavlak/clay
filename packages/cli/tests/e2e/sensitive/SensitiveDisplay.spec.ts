import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clayOutput } from '../helpers';

const DB = 'output "password" {\n  value     = "hunter2"\n  sensitive = true\n}\n';
const HIDDEN_BOTH = '(sensitive value) -> (sensitive value)';

const triggers = (name: string) =>
  `module "db" { source = "./db" }\nresource "null_resource" "n" {\n  triggers = { name = "${name}", token = module.db.password, list = ["a", module.db.password] }\n}\n`;

const exec = (command: string, lifecycle = '') => `module "db" { source = "./db" }\nresource "command_exec" "c" {\n  command = "${command}"\n${lifecycle}}\n`;

const pair = (a: string, b: string) => `module "db" { source = "./db" }\nresource "null_resource" "n" {\n  triggers = { a = ${a}, b = ${b} }\n}\n`;

describe('a resource attribute given a sensitive value, as the CLI prints it', () => {
  let dir: string;

  const clayIn = (...args: string[]) => clayOutput(dir, ...args);

  const written = async (config: string) => fs.writeFile(path.join(dir, 'main.clay'), config, 'utf8');

  const conf = (content: string, extra = '') =>
    `module "db" { source = "./db" }\n${extra}resource "local_file" "conf" {\n  path    = "${path.join(dir, 'conf.txt')}"\n  content = ${content}\n}\n`;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-display-'));
    await fs.mkdir(path.join(dir, 'db'));
    await fs.writeFile(path.join(dir, 'db', 'main.clay'), DB, 'utf8');
    await clayIn('init');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('says a part may be marked sensitive, where only what the apply finds tells', async () => {
    await written('resource "null_resource" "n" {\n  triggers = { t = "plain" }\n}\n');
    await clayIn('apply', '--yes');
    await written(
      'resource "random_string" "s" { length = 4 }\nresource "null_resource" "n" {\n  triggers = { t = (length(random_string.s.result) == 5 || sensitive(true)) ? "topsecret" : "b" }\n}\n'
    );

    const planned = await clayIn('plan');

    expect(planned).toContain('      triggers: {"t":(sensitive value)} -> {"t":(known after apply)}');
    expect(planned).toContain('      triggers: may be marked sensitive');
    expect(planned).not.toContain('topsecret');
  });

  it('says a part may be marked sensitive, where only a key not known yet may be, beside one that is exact', async () => {
    await written('resource "null_resource" "n" {\n  triggers = { c = "0" }\n}\n');
    await clayIn('apply', '--yes');
    await written(
      'resource "random_string" "s" { length = 4 }\nresource "null_resource" "n" {\n  triggers = merge({ for k in [random_string.s.result] : k => sensitive("q") }, { c = "0" })\n}\n'
    );

    expect(await clayIn('plan')).toContain('      triggers: may be marked sensitive');
  });

  it('says a part may no longer be marked sensitive, where only what the apply finds tells', async () => {
    await written('resource "null_resource" "n" {\n  triggers = { t = sensitive("plain") }\n}\n');
    await clayIn('apply', '--yes');
    await written(
      'resource "random_string" "s" { length = 4 }\nresource "null_resource" "n" {\n  triggers = { t = (length(random_string.s.result) == 5 || sensitive(true)) ? "topsecret" : "b" }\n}\n'
    );

    expect(await clayIn('plan')).toContain('      triggers: may no longer be marked sensitive');
  });

  it('hides only the sensitive parts of a value in a change', async () => {
    await written(triggers('app'));
    await clayIn('apply', '--yes');
    await written(triggers('web'));

    const planned = await clayIn('plan');

    expect(planned).toContain(
      '      triggers: {"name":"app","token":(sensitive value),"list":["a",(sensitive value)]} -> {"name":"web","token":(sensitive value),"list":["a",(sensitive value)]}'
    );
    expect(planned).not.toContain('hunter2');
  });

  it('hides the value on both sides of a change outside Clay and of the update that undoes it', async () => {
    await written(conf('"password=${module.db.password}"'));
    await clayIn('apply', '--yes');
    await fs.writeFile(path.join(dir, 'conf.txt'), 'changed outside', 'utf8');

    const planned = await clayIn('plan');

    expect(planned).toContain(`was changed outside Clay\n      content: ${HIDDEN_BOTH}\n`);
    expect(planned).toContain(`local_file.conf will be updated\n      content: ${HIDDEN_BOTH}\n`);
    expect(planned).not.toContain('hunter2');
    expect(planned).not.toContain('changed outside"');
  });

  it.each([
    ['puts a mark on', '"password=old"', '"password=${module.db.password}"', 'will be marked sensitive'],
    ['takes a mark off', '"password=${module.db.password}"', '"password=new"', 'will no longer be marked sensitive'],
  ])('hides both sides of a change that %s, and says so', async (_, before, after, note) => {
    await written(conf(before));
    await clayIn('apply', '--yes');
    await written(conf(after));

    const planned = await clayIn('plan');

    expect(planned).toContain(`local_file.conf will be updated\n      content: ${HIDDEN_BOTH}\n      content: ${note}\n`);
    expect(planned).not.toMatch(/hunter2|password=old|password=new/);
  });

  it.each([
    ['takes the mark off', '"password=new"', `content: ${HIDDEN_BOTH}\n      content: will no longer be marked sensitive\n`],
    ['keeps it marked', '"new=${module.db.password}"', `content: ${HIDDEN_BOTH}\n\n`],
  ])('reads the marks of a moved resource from where it was, where its change %s', async (_, after, shown) => {
    await written(conf('"password=${module.db.password}"'));
    await clayIn('apply', '--yes');
    await written(conf(`${after}\n  count   = 1`));

    const planned = await clayIn('plan');

    expect(planned).toContain(`local_file.conf[0] will be updated, moved from local_file.conf\n      ${shown}`);
    expect(planned).not.toContain('hunter2');
  });

  it('says a replace takes the mark off', async () => {
    await written(conf('"password=${module.db.password}"'));
    await clayIn('apply', '--yes');
    await written(conf('"password=new"').replace('conf.txt', 'moved.txt'));

    expect(await clayIn('plan')).toContain('      content: will no longer be marked sensitive\n');
  });

  it('hides a sensitive value the plan does not know yet, rather than saying it is not known', async () => {
    await written(conf('module.db.password'));
    await clayIn('apply', '--yes');
    await written(conf('"${module.db.password}${random_string.r.result}"', 'resource "random_string" "r" { length = 4 }\n'));

    expect(await clayIn('plan')).toContain(`local_file.conf will be updated\n      content: ${HIDDEN_BOTH}\n`);
  });

  it('hides only the sensitive parts in clay state show', async () => {
    await written(triggers('app'));
    await clayIn('apply', '--yes');

    const shown = await clayIn('state', 'show', 'null_resource.n');

    expect(shown).toContain('  triggers = {"name":"app","token":(sensitive value),"list":["a",(sensitive value)]}\n');
    expect(shown).not.toContain('hunter2');
  });

  it('hides what a command prints when the command holds a sensitive value, and only then', async () => {
    await written(
      'module "db" { source = "./db" }\nresource "command_exec" "secret" { command = "echo ${module.db.password}" }\nresource "command_exec" "plain" { command = "echo hello" }\n'
    );
    await clayIn('apply', '--yes');

    const secret = await clayIn('state', 'show', 'command_exec.secret');
    const plain = await clayIn('state', 'show', 'command_exec.plain');

    expect(secret).toContain('  stdout = (sensitive value)\n');
    expect(secret).not.toContain('hunter2');
    expect(plain).toContain('  stdout = "hello\\n"\n');
  });

  it('keeps what a command printed hidden while the sensitive command is ignored', async () => {
    await written(exec('echo ${module.db.password}'));
    await clayIn('apply', '--yes');
    await written(exec('echo hi', '  lifecycle { ignore_changes = [command] }\n'));

    const planned = await clayIn('plan');
    await clayIn('apply', '--yes');
    const shown = await clayIn('state', 'show', 'command_exec.c');

    expect(planned).not.toContain('will no longer be marked sensitive');
    expect(shown).toContain('  stdout = (sensitive value)\n');
    expect(shown).not.toContain('hunter2');
  });

  it('hides the id of a file whose path is sensitive', async () => {
    await written(`module "db" { source = "./db" }\nresource "local_file" "f" {\n  path    = "${path.join(dir, '${module.db.password}.txt')}"\n  content = "x"\n}\n`);
    await clayIn('apply', '--yes');

    const shown = await clayIn('state', 'show', 'local_file.f');

    expect(shown).toContain('  id = (sensitive value)\n');
    expect(shown).not.toContain('hunter2');
  });

  it('names each attribute whose sensitive parts change where no value does', async () => {
    await written(pair('module.db.password', '"hunter2"'));
    await clayIn('apply', '--yes');
    await written(pair('"hunter2"', 'module.db.password'));

    const planned = await clayIn('plan');

    expect(planned).toContain('  ~ null_resource.n will be updated\n      triggers: which parts are sensitive changes\n\nPlan: 0 to add, 1 to change, 0 to destroy.');
    expect(planned).not.toContain('hunter2');
  });
});
