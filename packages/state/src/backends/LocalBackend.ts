import * as fs from 'node:fs/promises';
import path from 'node:path';

import { emptyState, State } from '@clay/contracts';

import { StateBackend } from '../StateBackend';

function serialize(state: State): string {
  return JSON.stringify(state, null, 2);
}

export class LocalBackend implements StateBackend {
  private filePath: string;
  private lockFilePath: string;

  constructor(workingDir: string, filename: string = 'clay.state.json') {
    this.filePath = path.join(workingDir, filename);
    this.lockFilePath = `${this.filePath}.lock`;
  }

  /** A caller that reports where it looked needs the name this backend settled on. */
  get path(): string {
    return this.filePath;
  }

  async read(): Promise<State> {
    try {
      const content = await fs.readFile(this.filePath);
      return JSON.parse(content.toString('utf8')) as State;
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === 'ENOENT') return emptyState();

      throw error;
    }
  }

  async write(state: State): Promise<void> {
    try {
      await fs.access(this.filePath);
      await fs.copyFile(this.filePath, `${this.filePath}.bak`);
    } catch {
      // The first write has nothing to back up.
    }

    // Rename is atomic, so a run killed mid-write leaves the old state whole.
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, serialize(state), 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }

  /** The file system decides, so nothing can slip in between the check and the write. */
  async writeIfAbsent(state: State): Promise<boolean> {
    try {
      await fs.writeFile(this.filePath, serialize(state), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') return false;

      throw error;
    }
  }

  async lock(): Promise<void> {
    try {
      await fs.writeFile(this.lockFilePath, String(Date.now()), { flag: 'wx' });
    } catch (error) {
      if ((error as { code: string }).code === 'EEXIST') throw new Error(`State is locked by another run. If that run is gone, remove ${this.lockFilePath}`);

      throw error;
    }
  }

  async unlock(): Promise<void> {
    try {
      await fs.unlink(this.lockFilePath);
    } catch (error) {
      if ((error as { code: string }).code !== 'ENOENT') throw error;

      // Unlocking twice is not an error.
    }
  }
}
