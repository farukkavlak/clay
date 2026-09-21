import { IProvider } from '@clay/contracts';

/** The providers a run can use, each under the resource types it handles. */
export class ProviderRegistry {
  private providers: Map<string, IProvider> = new Map();

  register(provider: IProvider): void {
    for (const resourceType of provider.resources) {
      if (this.providers.has(resourceType)) throw new Error(`Provider for resource type "${resourceType}" already registered`);

      this.providers.set(resourceType, provider);
    }
  }

  get(type: string): IProvider {
    const provider = this.providers.get(type);
    if (!provider) throw new Error(`No provider handles "${type}"`);

    return provider;
  }
}
