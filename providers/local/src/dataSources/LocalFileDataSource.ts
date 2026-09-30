import { DataSourceHandler } from '@clay/contracts';
import fs from 'node:fs/promises';

export class LocalFileDataSource implements DataSourceHandler {
  async validate(inputs: Record<string, unknown>): Promise<void> {
    if (!inputs.path || typeof inputs.path !== 'string') throw new Error('local_file requires "path" attribute (string)');
  }

  async read(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const filePath = inputs.path as string;

    try {
      return { content: await fs.readFile(filePath, 'utf8') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`local_file cannot read "${filePath}": there is no such file`, { cause: error });

      throw error;
    }
  }
}
