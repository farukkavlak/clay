import fs from 'node:fs/promises';

/** Only a missing file is missing; one that is there but cannot be reached is an error to report. */
export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;

    throw error;
  }
}
