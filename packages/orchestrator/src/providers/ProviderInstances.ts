import { Provider, Schema } from '@clay/provider';

import { asError } from '../asError';
import { Limit } from './Limit';
import { ProviderRegistry } from './ProviderRegistry';

/**
 * One run's providers: each made new and configured by its node in the graph, before any block of its types asks it anything. A check of
 * values goes to the instance no run configures, so a block is valid or not whatever the configuration of its provider.
 */
export class ProviderInstances {
  private readonly configured = new Map<string, Provider>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly limit: Limit
  ) {}

  async configure(name: string): Promise<void> {
    const provider = this.registry.create(name);
    try {
      await this.limit.run(async () => {
        await provider.configure?.({});
      });
    } catch (error) {
      throw new Error(`provider "${name}": ${asError(error).message}`, { cause: error });
    }

    this.configured.set(name, provider);
  }

  get(type: string): Provider {
    return this.instance(this.registry.get(type).name);
  }

  /** Looked up apart from resources, since a type may be one and not the other. */
  reader(type: string): Provider {
    return this.instance(this.registry.reader(type).name);
  }

  async validate(type: string, config: Record<string, unknown>): Promise<void> {
    await this.registry.get(type).validate(type, config);
  }

  async validateDataSource(type: string, config: Record<string, unknown>): Promise<void> {
    await this.registry.reader(type).validateDataSource(type, config);
  }

  async schema(type: string): Promise<Schema> {
    return this.registry.schema(type);
  }

  private instance(name: string): Provider {
    const provider = this.configured.get(name);
    if (!provider) throw new Error(`provider "${name}" is asked before it is configured, which is a bug in Clay`);

    return provider;
  }
}
