import { IProvider, IResourceHandler, ISchema } from '@clay/contracts';

import { CommandExecResource } from './resources/CommandExecResource';
import { LocalFileResource } from './resources/LocalFileResource';
import { NullResource } from './resources/NullResource';
import { RandomStringResource } from './resources/RandomStringResource';

export class LocalProvider implements IProvider {
  readonly resources = ['local_file', 'random_string', 'null_resource', 'command_exec'];
  private handlers: Map<string, IResourceHandler> = new Map();

  constructor() {
    this.handlers.set('local_file', new LocalFileResource());
    this.handlers.set('random_string', new RandomStringResource());
    this.handlers.set('null_resource', new NullResource());
    this.handlers.set('command_exec', new CommandExecResource());
  }

  async getSchema(type: string): Promise<ISchema> {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`Unsupported resource type: ${type}`);

    return await handler.getSchema();
  }

  async validate(type: string, inputs: Record<string, unknown>): Promise<void> {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`Unsupported resource type: ${type}`);

    await handler.validate(inputs);
  }

  async create(type: string, inputs: Record<string, unknown>): Promise<string> {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`Unsupported resource type: ${type}`);

    return await handler.create(inputs);
  }

  async update(id: string, type: string, inputs: Record<string, unknown>): Promise<void> {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`Unsupported resource type: ${type}`);

    await handler.update(id, inputs);
  }

  async delete(id: string, type: string): Promise<void> {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`Unsupported resource type: ${type}`);

    await handler.delete(id);
  }

  async read(type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`Unsupported resource type: ${type}`);

    return await handler.read(inputs);
  }
}

export { LocalFileResource } from './resources/LocalFileResource';
export { RandomStringResource } from './resources/RandomStringResource';
export { NullResource } from './resources/NullResource';
export { CommandExecResource } from './resources/CommandExecResource';
