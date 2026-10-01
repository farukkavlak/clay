import { CreateRequest, DataSourceHandler, PlannedChange, PlanRequest, Provider, ResourceHandler, Schema, UpdateRequest } from '@clay/contracts';

import { LocalFileDataSource } from './dataSources/LocalFileDataSource';
import { CommandExecResource } from './resources/CommandExecResource';
import { LocalFileResource } from './resources/LocalFileResource';
import { NullResource } from './resources/NullResource';
import { RandomStringResource } from './resources/RandomStringResource';

export class LocalProvider implements Provider {
  readonly resources = ['local_file', 'random_string', 'null_resource', 'command_exec'];
  readonly dataSources = ['local_file'];
  private handlers: Map<string, ResourceHandler> = new Map();
  private dataHandlers: Map<string, DataSourceHandler> = new Map();

  constructor() {
    this.handlers.set('local_file', new LocalFileResource());
    this.handlers.set('random_string', new RandomStringResource());
    this.handlers.set('null_resource', new NullResource());
    this.handlers.set('command_exec', new CommandExecResource());
    this.dataHandlers.set('local_file', new LocalFileDataSource());
  }

  private handler(type: string): ResourceHandler {
    const handler = this.handlers.get(type);
    if (!handler) throw new Error(`Unsupported resource type: ${type}`);

    return handler;
  }

  private dataHandler(type: string): DataSourceHandler {
    const handler = this.dataHandlers.get(type);
    if (!handler) throw new Error(`Unsupported data source type: ${type}`);

    return handler;
  }

  async getSchema(type: string): Promise<Schema> {
    return await this.handler(type).getSchema();
  }

  async validate(type: string, inputs: Record<string, unknown>): Promise<void> {
    await this.handler(type).validate(inputs);
  }

  async plan(type: string, request: PlanRequest): Promise<PlannedChange> {
    return await this.handler(type).plan(request);
  }

  async read(type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return await this.handler(type).read(prior);
  }

  async create(type: string, request: CreateRequest): Promise<Record<string, unknown>> {
    return await this.handler(type).create(request);
  }

  async update(type: string, request: UpdateRequest): Promise<Record<string, unknown>> {
    return await this.handler(type).update(request);
  }

  async delete(type: string, prior: Record<string, unknown>): Promise<void> {
    await this.handler(type).delete(prior);
  }

  async getDataSourceSchema(type: string): Promise<Schema> {
    return await this.dataHandler(type).getSchema();
  }

  async validateDataSource(type: string, inputs: Record<string, unknown>): Promise<void> {
    await this.dataHandler(type).validate(inputs);
  }

  async readDataSource(type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.dataHandler(type).read(inputs);
  }
}

export { LocalFileResource } from './resources/LocalFileResource';
export { RandomStringResource } from './resources/RandomStringResource';
export { NullResource } from './resources/NullResource';
export { CommandExecResource } from './resources/CommandExecResource';
