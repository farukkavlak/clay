import fs from 'node:fs/promises';

/** Spawn reports a missing directory as the shell not found, so it is checked first. */
export async function checkDirectory(attribute: string, dir: string): Promise<void> {
  try {
    const stats = await fs.stat(dir);
    if (stats.isDirectory()) return;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  throw new Error(`${attribute} ${JSON.stringify(dir)} is not a directory`);
}
