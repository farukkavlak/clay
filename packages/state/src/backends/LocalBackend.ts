import * as fs from 'node:fs/promises';
import path from 'node:path';

import { IStateBackend } from '../IStateBackend';
import { IState } from '../StateManager';

function serialize(state: IState): string {
  return JSON.stringify(state, null, 2);
}

/**
 * Local file system backend for state storage.
 * Stores state in a JSON file with locking and backup support.
 */
export class LocalBackend implements IStateBackend {
  private filePath: string;
  private lockFilePath: string;

  constructor(workingDir: string = process.cwd(), filename: string = 'miniform.state.json') {
    this.filePath = path.join(workingDir, filename);
    this.lockFilePath = `${this.filePath}.lock`;
  }

  /** A caller that reports where it looked needs the name this backend settled on. */
  get path(): string {
    return this.filePath;
  }

  async read(): Promise<IState> {
    try {
      const content = await fs.readFile(this.filePath);
      return JSON.parse(content.toString('utf8')) as IState;
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === 'ENOENT')
        // Return empty state if file doesn't exist
        return { version: 1, resources: {} };

      throw error;
    }
  }

  async write(state: IState): Promise<void> {
    // Create backup if file exists
    try {
      await fs.access(this.filePath);
      await fs.copyFile(this.filePath, `${this.filePath}.bak`);
    } catch {
      // File doesn't exist, no backup needed
    }

    await fs.writeFile(this.filePath, serialize(state), 'utf8');
  }

  /** The file system decides, so nothing can slip in between the check and the write. */
  async writeIfAbsent(state: IState): Promise<boolean> {
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
      // 'wx' flag fails if file exists
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

      // If lock file doesn't exist, it's already unlocked (idempotent)
    }
  }
}
