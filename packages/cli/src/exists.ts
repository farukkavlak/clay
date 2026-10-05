import fs from 'node:fs/promises';

/** Only ENOENT means missing; any other error is thrown. */
export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;

    throw error;
  }
}
