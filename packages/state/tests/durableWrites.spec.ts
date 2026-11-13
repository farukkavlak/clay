import { emptyState, State } from '@clay/contracts';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adoptBackend, LocalBackend, rememberedBackend, StateManager } from '../src';

const PREFIX = 'clay-durable-';

// A power loss cannot be staged, so the order of the flushes, renames and removals is what is checked.
const seen = vi.hoisted(() => ({ steps: [] as string[], failing: undefined as string | undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const { default: path } = await import('node:path');
  const named = (target: unknown) => {
    const name = path.basename(String(target)).replace(/[0-9a-f]{8}-[0-9a-f-]{27}$/, '<id>');
    return name.startsWith('clay-durable-') ? 'dir' : name;
  };

  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (seen.failing === named(args[0])) throw new Error('EIO: the disk failed');
        seen.steps.push(`sync ${named(args[0])}`);
        return sync();
      };
      return handle;
    }),
    rename: vi.fn(async (from: string, to: string) => {
      seen.steps.push(`rename ${named(from)} ${named(to)}`);
      return actual.rename(from, to);
    }),
    link: vi.fn(async (from: string, to: string) => {
      seen.steps.push(`link ${named(from)} ${named(to)}`);
      return actual.link(from, to);
    }),
    unlink: vi.fn(async (target: string) => {
      seen.steps.push(`unlink ${named(target)}`);
      return actual.unlink(target);
    }),
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      seen.steps.push(`rm ${named(args[0])}`);
      return actual.rm(...args);
    }),
  };
});

const holding = (serial: number): State => ({ ...emptyState(), serial });

describe('a local write a power loss cannot undo', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), PREFIX));
    seen.steps.length = 0;
    seen.failing = undefined;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A state with a journal beside it, as a stopped run leaves, so the next write backs it up and removes the journal. */
  async function leftByAStoppedRun(): Promise<void> {
    const backend = new LocalBackend(dir);
    await backend.write(holding(1));
    await backend.append('{"serial":2,"key":"rt.a","resource":null,"deposed":null}\n');
    seen.steps.length = 0;
  }

  it('flushes the backup and the new state, and their directory, before the journal is removed', async () => {
    await leftByAStoppedRun();

    await new LocalBackend(dir).write(holding(3));

    expect(seen.steps).toEqual(['sync clay.state.json.bak', 'sync clay.state.json.tmp', 'rename clay.state.json.tmp clay.state.json', 'sync dir', 'rm clay.state.json.journal']);
  });

  it.each([
    ['the new state', 'clay.state.json.tmp'],
    ['the directory', 'dir'],
  ])('keeps the journal where %s cannot be flushed', async (_, failing) => {
    await leftByAStoppedRun();
    seen.failing = failing;

    await expect(new LocalBackend(dir).write(holding(3))).rejects.toThrow('EIO: the disk failed');

    await expect(fs.readFile(path.join(dir, 'clay.state.json.journal'), 'utf8')).resolves.toContain('"serial":2');
  });

  it('flushes a journal line, and the directory that names the journal', async () => {
    await new LocalBackend(dir).append('{}\n');

    expect(seen.steps).toEqual(['sync clay.state.json.journal', 'sync dir']);
  });

  it('flushes only the line once the directory names the journal, and the directory again for a journal made after a write', async () => {
    const backend = new LocalBackend(dir);
    await backend.append('{}\n');
    seen.steps.length = 0;

    await backend.append('{}\n');
    await backend.write(holding(1));
    await backend.append('{}\n');

    expect(seen.steps).toEqual([
      'sync clay.state.json.journal',
      'sync clay.state.json.tmp',
      'rename clay.state.json.tmp clay.state.json',
      'sync dir',
      'rm clay.state.json.journal',
      'sync clay.state.json.journal',
      'sync dir',
    ]);
  });

  it('passes on a journal line that cannot be flushed', async () => {
    seen.failing = 'clay.state.json.journal';

    await expect(new LocalBackend(dir).append('{}\n')).rejects.toThrow('EIO: the disk failed');
  });

  it('flushes a first state before it is linked, and the directory after', async () => {
    await new LocalBackend(dir).writeIfAbsent(emptyState());

    expect(seen.steps).toEqual(['sync clay.state.json.<id>', 'link clay.state.json.<id> clay.state.json', 'sync dir', 'rm clay.state.json.<id>']);
  });

  it('flushes the directory once the lock is removed', async () => {
    const backend = new LocalBackend(dir);
    const manager = new StateManager(backend);
    await manager.lock('apply');
    seen.steps.length = 0;

    await manager.unlock();

    expect(seen.steps).toEqual(['unlink clay.state.json.lock', 'sync dir']);
  });

  it('flushes the record of a backend, the directory it made for it, and the directory that holds it', async () => {
    const backend = rememberedBackend(dir, {});

    await adoptBackend(new LocalBackend(dir, 'other.json'), { backend, manager: new StateManager(backend) }, dir, async () => true);

    expect(seen.steps).toEqual(['sync dir', 'sync backend.json.tmp', 'rename backend.json.tmp backend.json', 'sync .clay']);
  });
});
