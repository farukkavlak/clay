import { isName, NAME_RULE } from '@clay/core';
import { Provider, Schema } from '@clay/provider';

import { checkDataSourceSchema, checkSchema } from './providerResult';

/** A name no configuration can write, an importable type the provider does not make, or one with no way to import it, is a fault in the provider. */
function checkProvider(provider: Provider): void {
  if (!isName(provider.name)) throw new Error(`A provider is named ${JSON.stringify(provider.name)}, which is a bug in the provider: a name ${NAME_RULE}`);

  for (const type of provider.importable ?? []) {
    if (!provider.resources.includes(type)) throw new Error(`A provider lists "${type}" as importable, but does not make it`);
    if (!provider.importResource) throw new Error(`A provider lists "${type}" as importable, but has no importResource`);
  }
}

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();
  private readers: Map<string, Provider> = new Map();
  private named: Map<string, Provider> = new Map();

  /** Everything is checked before anything is kept, so a provider refused leaves no type of it behind. */
  register(provider: Provider): void {
    checkProvider(provider);
    if (this.named.has(provider.name)) throw new Error(`A provider named "${provider.name}" is already registered`);

    const taken = provider.resources.find((type) => this.providers.has(type));
    if (taken !== undefined) throw new Error(`Provider for resource type "${taken}" already registered`);
    const read = provider.dataSources.find((type) => this.readers.has(type));
    if (read !== undefined) throw new Error(`Provider for data source type "${read}" already registered`);

    for (const type of provider.resources) this.providers.set(type, provider);
    for (const type of provider.dataSources) this.readers.set(type, provider);
    this.named.set(provider.name, provider);
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

  /** Whether a block of the type may be imported, asked before any provider is called. */
  importable(type: string): boolean {
    return this.get(type).importable?.includes(type) === true;
  }

  async schema(type: string): Promise<Schema> {
    return checkSchema(type, await this.get(type).getSchema(type));
  }

  async dataSourceSchema(type: string): Promise<Schema> {
    return checkDataSourceSchema(type, await this.reader(type).getDataSourceSchema(type));
  }
}
