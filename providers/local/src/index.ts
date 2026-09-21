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

  private handler(type: string): IResourceHandler {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`Unsupported resource type: ${type}`);

    return handler;
  }

  async getSchema(type: string): Promise<ISchema> {
    return await this.handler(type).getSchema();
  }

  async validate(type: string, inputs: Record<string, unknown>): Promise<void> {
    await this.handler(type).validate(inputs);
  }

  async create(type: string, inputs: Record<string, unknown>): Promise<string> {
    return await this.handler(type).create(inputs);
  }

  async update(id: string, type: string, inputs: Record<string, unknown>): Promise<void> {
    await this.handler(type).update(id, inputs);
  }

  async delete(id: string, type: string): Promise<void> {
    await this.handler(type).delete(id);
  }

  async read(type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.handler(type).read(inputs);
  }
}

export { LocalFileResource } from './resources/LocalFileResource';
export { RandomStringResource } from './resources/RandomStringResource';
export { NullResource } from './resources/NullResource';
export { CommandExecResource } from './resources/CommandExecResource';
