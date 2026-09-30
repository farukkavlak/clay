import { Provider } from '@clay/contracts';

/** The providers a run can use, each under the resource types it handles and the data source types it reads. */
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

  /** A type may be a resource and not a data source, so the two are looked up apart. */
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
}
