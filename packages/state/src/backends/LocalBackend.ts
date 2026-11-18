import { randomUUID } from 'node:crypto';
import { Dirent, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { emptyState, isWorkspaceName, State, WrittenState } from '@clay/contracts';

import { LockInfo, lockInfoFrom, noLockAt, otherLockAt, StateLocked } from '../lockInfo';
import { BackendChoice, DEFAULT_WORKSPACE, NamedWorkspace, WORKSPACES_FOLDER } from '../StateBackend';
import { Journal, parseState, serializeState } from '../stateFile';
import { appendSynced, syncDir, writeSynced } from './durable';

/** Undefined where nothing is there, or a file stands in the way of the path. */
async function statOf(target: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(target);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;

    throw error;
  }
}

/** False where something is there already. A link fails on a target that exists, and the file it links is already full. */
async function createFilled(target: string, content: string): Promise<boolean> {
  const filling = `${target}.${randomUUID()}`;
  try {
    await writeSynced(filling, content);
    await fs.link(filling, target);
    await syncDir(path.dirname(target));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;

    throw error;
  } finally {
    await fs.rm(filling, { force: true });
  }
}

const workspacesOf = (defaultPath: string) => path.join(path.dirname(defaultPath), WORKSPACES_FOLDER);

/** Next to the default state, so they stay in the folder a `path` setting chooses. */
function workspacePath(defaultPath: string, workspace: string): string {
  if (workspace === DEFAULT_WORKSPACE) return defaultPath;

  return path.join(workspacesOf(defaultPath), workspace, path.basename(defaultPath));
}

/** False where something is in it, as another run may put there. */
async function removedIfEmpty(folder: string): Promise<boolean> {
  try {
    await fs.rmdir(folder);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;

    throw error;
  }
}

/** Nothing where the folder of workspaces is missing, or a file stands in its place. */
async function entriesOf(folder: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(folder, { withFileTypes: true });
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];

    throw error;
  }
}

export class LocalBackend implements NamedWorkspace {
  readonly choice: BackendChoice;
  private readonly workingDir: string;
  private readonly defaultPath: string;
  private filePath: string;
  private lockFilePath: string;
  private journalPath: string;
  private readonly workspaceName: string;
  private backedUp = false;
  private journalNamed = false;
  /** Set by `prepare`, as `workspace new` makes the workspace whose lock it then takes. */
  private making = false;

  constructor(workingDir: string, filename: string = 'clay.state.json', workspace: string = DEFAULT_WORKSPACE) {
    const defaultPath = path.resolve(workingDir, filename);
    this.workingDir = workingDir;
    this.defaultPath = defaultPath;
    this.workspaceName = workspace;
    this.filePath = workspacePath(defaultPath, workspace);
    this.lockFilePath = `${this.filePath}.lock`;
    this.journalPath = `${this.filePath}.journal`;
    const where = path.relative(workingDir, defaultPath);
    this.choice = { type: 'local', where, settings: { path: where } };
  }

  workspace(name: string): LocalBackend {
    return new LocalBackend(this.workingDir, this.choice.where, name);
  }

  /** A folder that holds no state of the default's file name is not a workspace, so a stopped `workspace new` leaves none. */
  async listWorkspaces(): Promise<string[]> {
    const named: string[] = [];
    for (const entry of await entriesOf(workspacesOf(this.defaultPath))) if (await this.isWorkspace(entry)) named.push(entry.name);

    return [DEFAULT_WORKSPACE, ...named.sort()];
  }

  private async isWorkspace(entry: Dirent): Promise<boolean> {
    if (!entry.isDirectory() || entry.name === DEFAULT_WORKSPACE || !isWorkspaceName(entry.name)) return false;

    return this.workspace(entry.name).exists();
  }

  /** The folder of a named workspace is Clay's own, unlike the one a `path` setting names, so it is made here. */
  async prepare(): Promise<void> {
    if (this.filePath === this.defaultPath) return;

    this.making = true;
    const folder = path.dirname(this.filePath);
    const made = await fs.mkdir(folder, { recursive: true });
    if (made === undefined) return;

    // Each folder made is named in the one that holds it.
    await syncDir(path.dirname(made));
    if (made !== folder) await syncDir(path.dirname(folder));
  }

  /** The journal goes first, so a stopped removal never leaves lines a new state of this workspace would read. */
  async remove(): Promise<void> {
    if (this.filePath === this.defaultPath) throw new Error('The state of the default workspace is not removed');

    for (const file of [this.journalPath, `${this.filePath}.bak`, this.filePath]) await fs.rm(file, { force: true });
    await syncDir(path.dirname(this.filePath));
  }

  /** The folders are Clay's own, made by `prepare`; the one of the default state is not. */
  async prune(): Promise<void> {
    if (this.filePath === this.defaultPath) return;

    const folder = path.dirname(this.filePath);
    if (await removedIfEmpty(folder)) await removedIfEmpty(path.dirname(folder));
  }

  get location(): string {
    return this.filePath;
  }

  async check(): Promise<void> {
    const file = await statOf(this.filePath);
    if (file?.isDirectory()) throw new Error(`${this.filePath} is a directory, and the state is a file`);

    const parent = path.dirname(this.filePath);
    const holder = await statOf(parent);
    if (!holder?.isDirectory()) throw new Error(`${parent} is not a directory, so the state cannot be kept in it; Clay makes none`);
  }

  /** Only ENOENT means missing; any other error is thrown. */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;

      throw error;
    }
  }

  /** A journal counts: a state moved without it would lose what a stopped run recorded. */
  async holdsAnything(): Promise<boolean> {
    return (await this.exists()) || (await statOf(this.journalPath)) !== undefined;
  }

  async read(): Promise<State> {
    try {
      const content = await fs.readFile(this.filePath);
      return parseState(content.toString('utf8'), this.filePath, await this.readJournal());
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      if (this.mustExist) throw this.missing();

      return emptyState();
    }
  }

  async write(state: WrittenState): Promise<void> {
    if (!this.backedUp) await this.backUp();

    // Rename is atomic, so a run killed mid-write leaves the old state whole.
    const tmpPath = `${this.filePath}.tmp`;
    await writeSynced(tmpPath, serializeState(state));
    await fs.rename(tmpPath, this.filePath);
    // A journal removed before the rename is on disk would leave the old state without what the run recorded.
    await syncDir(path.dirname(this.filePath));
    // Its lines are in the state now; a run stopped before this point leaves lines of an older serial, which are skipped.
    await fs.rm(this.journalPath, { force: true });
    this.journalNamed = false;
  }

  /** As it is read, so what a stopped run left in the journal is in the backup too. */
  private async copyBefore(): Promise<void> {
    const journal = await this.readJournal();
    const content = await fs.readFile(this.filePath);
    // Its name is flushed with the directory once the state is renamed.
    await writeSynced(`${this.filePath}.bak`, journal ? serializeState(parseState(content.toString('utf8'), this.filePath, journal)) : content);
  }

  async append(lines: string): Promise<void> {
    await appendSynced(this.journalPath, lines);
    if (this.journalNamed) return;

    // The first line makes the journal, whose name is the directory's; the next ones only grow it.
    await syncDir(path.dirname(this.journalPath));
    this.journalNamed = true;
  }

  private async readJournal(): Promise<Journal | undefined> {
    try {
      return { content: await fs.readFile(this.journalPath, 'utf8'), source: this.journalPath };
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;

      throw error;
    }
  }

  /** Once per lock, so the backup is the state from before the run. */
  private async backUp(): Promise<void> {
    try {
      await this.copyBefore();
    } catch (error) {
      // No state file yet means nothing to back up; any other failure would leave no backup.
      const { code, message } = error as NodeJS.ErrnoException;
      if (code !== 'ENOENT') throw new Error(`Could not back up ${this.filePath} to ${this.filePath}.bak (${code ?? message}); the state was not written`, { cause: error });
    }

    this.backedUp = true;
  }

  async writeIfAbsent(state: WrittenState): Promise<boolean> {
    return createFilled(this.filePath, serializeState(state));
  }

  /** A named workspace deleted while this run waited is refused, so the run never writes it back. */
  async lock(info: LockInfo): Promise<void> {
    const taken = await this.lockCreated(info);
    if (!taken) throw new StateLocked(await this.holder(), `remove ${this.lockFilePath}`);

    this.backedUp = false;
    if (!this.mustExist || (await this.exists())) return;

    await this.unlock(info.id);
    throw this.missing();
  }

  /** A named workspace has a state, but where `workspace new` is making it; the default one runs without. */
  private get mustExist(): boolean {
    return this.filePath !== this.defaultPath && !this.making;
  }

  private missing(): Error {
    return new Error(`Workspace "${this.workspaceName}" does not exist`);
  }

  private async lockCreated(info: LockInfo): Promise<boolean> {
    try {
      return await createFilled(this.lockFilePath, JSON.stringify(info));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && this.mustExist) throw this.missing();

      throw error;
    }
  }

  /** A run that has just unlocked leaves no lock file. */
  private async holder(): Promise<LockInfo | undefined> {
    const text = await this.lockText();
    return text === undefined ? undefined : lockInfoFrom(text);
  }

  private async lockText(): Promise<string | undefined> {
    try {
      return await fs.readFile(this.lockFilePath, 'utf8');
    } catch (error) {
      const { code, message } = error as NodeJS.ErrnoException;
      if (code === 'ENOENT') return undefined;

      throw new Error(`The lock ${this.lockFilePath} cannot be read (${code ?? message})`, { cause: error });
    }
  }

  /** A lock already gone is released. One with another id is another run's, taken once this run's was removed. */
  async unlock(id: string): Promise<void> {
    await this.release(id, () => new Error(`${this.lockFilePath} holds a lock this run did not take, so it is left in place`));
  }

  async forceUnlock(id: string): Promise<void> {
    const found = await this.release(id, (holder) => otherLockAt(this.lockFilePath, holder, id));
    if (!found) throw noLockAt(this.lockFilePath);
  }

  /** False where no lock was there to release. */
  private async release(id: string, other: (holder: LockInfo | undefined) => Error): Promise<boolean> {
    const text = await this.lockText();
    if (text === undefined) return false;

    const holder = lockInfoFrom(text);
    if (holder?.id !== id) throw other(holder);

    try {
      await fs.unlink(this.lockFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // A removal lost to a power loss would stop the next run on a lock no run holds.
    await syncDir(path.dirname(this.lockFilePath));
    return true;
  }
}
