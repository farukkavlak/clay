import { Provider, Schema } from '@clay/contracts';

import { checkDataSourceSchema, checkSchema } from './providerResult';

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();
  private readers: Map<string, Provider> = new Map();

  register(provider: Provider): void {
    for (const resourceType of provider.resources) {
      if (this.providers.has(resourceType)) throw new Error(`Provider for resource type "${resourceType}" already registered`);

      this.providers.set(resourceType, provider);
    }

    for (const dataSourceType of provider.dataSources) {
      if (this.readers.has(dataSourceType)) throw new Error(`Provider for data source type "${dataSourceType}" already registered`);

      this.readers.set(dataSourceType, provider);
    }
  }

  /** Looked up apart from resources, since a type may be one and not the other. */
  reader(type: string): Provider {
    const provider = this.readers.get(type);
    if (!provider) throw new Error(`No provider reads data source "${type}"`);

    return provider;
  }

  get(type: string): Provider {
    const provider = this.providers.get(type);
    if (!provider) throw new Error(`No provider handles "${type}"`);

    return provider;
  }

  async schema(type: string): Promise<Schema> {
    return checkSchema(type, await this.get(type).getSchema(type));
  }

  async dataSourceSchema(type: string): Promise<Schema> {
    return checkDataSourceSchema(type, await this.reader(type).getDataSourceSchema(type));
  }
}
