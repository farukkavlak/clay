import { randomUUID } from 'node:crypto';
import { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { emptyState, State } from '@clay/contracts';

import { LockInfo, lockInfoFrom, StateLocked } from '../lockInfo';
import { BackendChoice, StateBackend } from '../StateBackend';
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

export class LocalBackend implements StateBackend {
  readonly choice: BackendChoice;
  private filePath: string;
  private lockFilePath: string;
  private journalPath: string;
  private backedUp = false;
  private journalNamed = false;

  constructor(workingDir: string, filename: string = 'clay.state.json') {
    this.filePath = path.resolve(workingDir, filename);
    this.lockFilePath = `${this.filePath}.lock`;
    this.journalPath = `${this.filePath}.journal`;
    const where = path.relative(workingDir, this.filePath);
    this.choice = { type: 'local', where, settings: { path: where } };
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
      const err = error as { code?: string };
      if (err.code === 'ENOENT') return emptyState();

      throw error;
    }
  }

  async write(state: State): Promise<void> {
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

  async writeIfAbsent(state: State): Promise<boolean> {
    return createFilled(this.filePath, serializeState(state));
  }

  async lock(info: LockInfo): Promise<void> {
    const taken = await createFilled(this.lockFilePath, JSON.stringify(info));
    if (!taken) throw new StateLocked(await this.holder(), `remove ${this.lockFilePath}`);

    this.backedUp = false;
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
    const text = await this.lockText();
    if (text === undefined) return;
    if (lockInfoFrom(text)?.id !== id) throw new Error(`${this.lockFilePath} holds a lock this run did not take, so it is left in place`);

    try {
      await fs.unlink(this.lockFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // A removal lost to a power loss would stop the next run on a lock no run holds.
    await syncDir(path.dirname(this.lockFilePath));
  }
}
