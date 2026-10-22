import { CreateRequest, isUnknown, own, PlannedChange, planFromSchema, PlanRequest, ResourceHandler, Schema, types, UpdateRequest } from '@clay/contracts';
import fs from 'node:fs/promises';
import path from 'node:path';

import { idOf } from './idOf';

/** Not there: the path does not exist, or runs through a file. */
function missing(error: unknown): boolean {
  const { code } = error as NodeJS.ErrnoException;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** One case for names a file system that ignores case takes for one: `ß` and `SS` to `ss`. Unicode folds `ı` only in Turkish. */
function folded(name: string): string {
  const once = [...name].map((char) => (char === 'ı' ? char : char.toUpperCase().toLowerCase())).join('');

  return once === name ? name : folded(once);
}

/** A link's name as its directory spells it; on a file system that ignores case, `L.txt` for `l.txt`. */
async function linkIn(dir: string, written: string, link: { dev: number; ino: number }): Promise<string> {
  const names = await fs.readdir(dir);
  const alike = names.filter((name) => folded(name) === folded(written));
  const entries = await Promise.all(alike.map(async (name) => ({ name, ...(await fs.lstat(path.join(dir, name))) })));
  const found = entries.find(({ dev, ino }) => dev === link.dev && ino === link.ino);

  return found?.name ?? written;
}

const flipped = (name: string) => [...name].map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase())).join('');

/** Whether the name in another case finds the same entry. */
async function foundInAnyCase(dir: string, name: string): Promise<boolean> {
  try {
    const [entry, other] = await Promise.all([fs.lstat(path.join(dir, name)), fs.lstat(path.join(dir, flipped(name)))]);
    return entry.dev === other.dev && entry.ino === other.ino;
  } catch (error) {
    if (!missing(error)) throw error;

    return false;
  }
}

/** A name that turns into another case and back, which `ı` to `I` does not. */
const hasCase = (name: string) => flipped(name) !== name && flipped(flipped(name)) === name;

/**
 * Whether a directory, or the nearest one that exists above it, ignores case. Asked of an entry whose name has case; with none,
 * or a directory that cannot be listed, the directory above is asked, and with none up to the root, case counts.
 */
async function ignoresCase(dir: string): Promise<boolean> {
  try {
    for await (const { name } of await fs.opendir(dir)) if (hasCase(name)) return await foundInAnyCase(dir, name);
  } catch (error) {
    if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
  }
  const parent = path.dirname(dir);

  return parent !== dir && (await ignoresCase(parent));
}

/**
 * The file a path names, as the disk names it: links followed, in the case each part has. A part not made yet is kept as written,
 * in one case where its directory ignores case, so two spellings of one new file are one name.
 * A link at the `end` is itself, since a delete removes the link and not what it points to.
 */
async function onDisk(file: string, end = true): Promise<string> {
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);

  try {
    const entry = end ? await fs.lstat(absolute) : undefined;
    if (!entry?.isSymbolicLink()) return await fs.realpath(absolute);

    const dir = await onDisk(parent, false);
    return path.join(dir, await linkIn(dir, path.basename(absolute), entry));
  } catch (error) {
    if (!missing(error)) throw error;

    if (parent === absolute) return absolute;
    const dir = await onDisk(parent, false);
    const name = path.basename(absolute);

    return path.join(dir, (await ignoresCase(dir)) ? folded(name) : name);
  }
}

/** A path that names the file the id already is, as `./a.txt` for `a.txt` or a link to it, is written in place. */
async function keepingTheFile(change: PlannedChange, prior: Record<string, unknown> | null): Promise<PlannedChange> {
  const file = change.after.path;
  if (typeof file !== 'string' || typeof prior?.id !== 'string' || (await onDisk(file)) !== (await onDisk(prior.id))) return change;

  return { ...change, replace: change.replace.filter(([name]) => name !== 'path') };
}

export class LocalFileResource implements ResourceHandler {
  async getSchema(): Promise<Schema> {
    return {
      id: { type: types.string, computed: true, kept: true },
      path: { type: types.string, required: true, forceNew: true },
      content: { type: types.string, required: true, forceNew: false },
    };
  }

  async validate(inputs: Record<string, unknown>): Promise<void> {
    if (inputs.path === '') throw new Error('local_file "path" must not be empty');
  }

  // A relative path resolves where the apply runs, so only an absolute one gives a known id.
  async plan(request: PlanRequest): Promise<PlannedChange> {
    const change = await keepingTheFile(planFromSchema(await this.getSchema(), request), request.prior);
    const file = own(request.config, 'path');
    if (typeof file !== 'string' || !path.isAbsolute(file) || !isUnknown(change.after.id)) return change;

    return { ...change, after: { ...change.after, id: path.resolve(file) } };
  }

  async read(prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    try {
      return { ...prior, content: await fs.readFile(idOf(prior), 'utf8') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;

      throw error;
    }
  }

  async create({ planned }: CreateRequest): Promise<Record<string, unknown>> {
    const filePath = planned.path as string;
    const content = planned.content as string;

    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(filePath, content, 'utf8');

    return { ...planned, id: path.resolve(filePath) };
  }

  async update({ prior, planned }: UpdateRequest): Promise<Record<string, unknown>> {
    await fs.writeFile(idOf(prior), planned.content as string, 'utf8');

    return planned;
  }

  async delete(prior: Record<string, unknown>): Promise<void> {
    // A file already removed by hand counts as deleted.
    await fs.unlink(idOf(prior)).catch((error: { code?: string }) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  // The id once there is one, since a delete removes that; before it, the path a create writes, as the disk names it.
  async identify(values: Record<string, unknown>): Promise<string | undefined> {
    const file = typeof values.id === 'string' ? values.id : values.path;

    return typeof file === 'string' ? `the file ${await onDisk(file)}` : undefined;
  }
}
