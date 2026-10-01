import { isUnknown, own, PlannedChange, planFromSchema, PlanRequest, ResourceHandler, Schema } from '@clay/contracts';
import fs from 'node:fs/promises';
import path from 'node:path';

import { idOf } from './idOf';

export class LocalFileResource implements ResourceHandler {
  async getSchema(): Promise<Schema> {
    return {
      id: { type: 'string', computed: true, kept: true },
      path: { type: 'string', required: true, forceNew: true }, // Changing path means new file
      content: { type: 'string', required: true, forceNew: false }, // Changing content is update
    };
  }

  async validate(inputs: Record<string, unknown>): Promise<void> {
    if (!inputs.path || typeof inputs.path !== 'string') throw new Error('local_file requires "path" attribute (string)');

    if (typeof inputs.content !== 'string') throw new Error('local_file requires "content" attribute (string)');
  }

  // A relative path lands where the apply runs, so only an absolute one gives a known id.
  async plan(request: PlanRequest): Promise<PlannedChange> {
    const change = planFromSchema(await this.getSchema(), request);
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

  async create(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const filePath = inputs.path as string;
    const content = inputs.content as string;

    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(filePath, content, 'utf8');

    return { ...inputs, id: path.resolve(filePath) };
  }

  async update(prior: Record<string, unknown>, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const content = inputs.content as string;
    const id = idOf(prior);

    await fs.writeFile(id, content, 'utf8');

    return { ...inputs, id };
  }

  async delete(prior: Record<string, unknown>): Promise<void> {
    // A file removed by hand is already what a delete asks for.
    await fs.unlink(idOf(prior)).catch((error: { code?: string }) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
