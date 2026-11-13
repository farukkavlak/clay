import { CreateRequest, DataSourceHandler, Identity, PlannedChange, PlanRequest, Provider, ResourceHandler, Schema, UpdateRequest } from '@clay/contracts';

import { LocalFileDataSource } from './dataSources/LocalFileDataSource';
import { CommandExecResource } from './resources/CommandExecResource';
import { LocalFileResource } from './resources/LocalFileResource';
import { NullResource } from './resources/NullResource';
import { RandomStringResource } from './resources/RandomStringResource';

const importableIn = (handlers: Map<string, ResourceHandler>) => [...handlers].flatMap(([type, handler]) => (handler.importResource ? [type] : []));

export class LocalProvider implements Provider {
  private readonly handlers = new Map<string, ResourceHandler>([
    ['local_file', new LocalFileResource()],
    ['random_string', new RandomStringResource()],
    ['null_resource', new NullResource()],
    ['command_exec', new CommandExecResource()],
  ]);
  private readonly dataHandlers = new Map<string, DataSourceHandler>([['local_file', new LocalFileDataSource()]]);
  readonly resources = [...this.handlers.keys()];
  readonly dataSources = [...this.dataHandlers.keys()];
  readonly importable = importableIn(this.handlers);

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

  async identify(type: string, values: Record<string, unknown>): Promise<Identity | undefined> {
    return await this.handler(type).identify?.(values);
  }

  async importResource(type: string, id: string): Promise<Record<string, unknown> | null> {
    const handler = this.handler(type);
    if (!handler.importResource) throw new Error(`${type} cannot be imported`);

    return await handler.importResource(id);
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
export { LocalExecProvisioner } from './provisioners/LocalExecProvisioner';
