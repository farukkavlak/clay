import { DiskFiles, Orchestrator } from '@clay/orchestrator';
import { LocalProvider } from '@clay/provider-local';
import { LocalBackend, StateManager } from '@clay/state';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { start } from './start';

describe('a heredoc', () => {
  let dir: string;

  const apply = async (config: string) => {
    const engine = Orchestrator.create(new StateManager(new LocalBackend(dir)), new DiskFiles(dir));
    engine.registerProvider(new LocalProvider());
    for await (const event of start(engine, config)) if (event.type === 'failed') throw event.error;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-heredoc-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes its lines, less their shared indent, with what it reads', async () => {
    await apply(`
      variable "name" { default = "clay" }
      resource "local_file" "a" {
        path    = "${path.join(dir, 'a.txt')}"
        content = <<-EOT
          #!/bin/sh
          echo "hello \${var.name}"
            exit 0
          EOT
      }
    `);

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('#!/bin/sh\necho "hello clay"\n  exit 0\n');
  });

  // Git on Windows may check a file out with CRLF line breaks.
  it('writes the same lines from a file whose line breaks are CRLF', async () => {
    const config = ['resource "local_file" "a" {', `  path    = "${path.join(dir, 'a.txt')}"`, '  content = <<-EOT', '    a', '      b', '    EOT', '}', ''].join('\r\n');

    await apply(config);

    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('a\n  b\n');
  });
});
