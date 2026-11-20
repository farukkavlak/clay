import { AttributePath, Provider, Schema } from '@clay/provider';
import { ModuleAddress } from '@clay/core';
import { AttributeValue, ProviderBlock, spell } from '@clay/parser';

import { asError } from '../asError';
import { tryAt, withPlace } from '../place';
import { conformed, nameProblem, namesOf, writtenAt } from '../values/conformValues';
import { marksOf } from '../values/schemaMarks';
import { plainOf, Value } from '../values/Value';
import { hidingReason } from './providerResult';
import { Limit } from './Limit';
import { ProviderRegistry } from './ProviderRegistry';

/** A provider block, and how a value it writes is read in the root module. */
export interface Written {
  block: ProviderBlock;
  read: (value: AttributeValue) => Value;
}

/** What `configure` is given, and the paths of it that are sensitive. */
interface Configuration {
  config: Record<string, unknown>;
  sensitive: AttributePath[];
}

/**
 * One run's providers: each made new and configured by its node in the graph, before any block of its types asks it anything. A check of
 * values goes to the instance no run configures, so a block is valid or not whatever the configuration of its provider.
 */
export class ProviderInstances {
  private readonly configured = new Map<string, Provider>();

  constructor(
    private readonly registry: ProviderRegistry,
    // Loaded with the configuration, for each provider block.
    private readonly configSchemas: Map<string, Schema>,
    private readonly limit: Limit
  ) {}

  async configure(name: string, written?: Written): Promise<void> {
    const { config, sensitive } = await this.check(name, written);
    const provider = this.registry.create(name);
    const type = `provider "${name}"`;
    try {
      await hidingReason(type, sensitive, () => this.limit.run(async () => provider.configure?.(config)), 'to configure');
    } catch (error) {
      // A hidden reason already names the provider.
      if (sensitive.length > 0) throw error;
      throw new Error(`${type}: ${asError(error).message}`, { cause: error });
    }

    this.configured.set(name, provider);
  }

  /** What the block sets, held to the provider's schema for it; a check goes no further, since a value may not be known yet. */
  async check(name: string, written?: Written): Promise<Configuration> {
    if (written === undefined) return this.unwritten(name);

    const { block, read } = written;
    const declaration = spell(block);
    const schema = this.configSchemas.get(name)!;
    const values = Object.fromEntries(
      Object.entries(block.attributes).map(([key, value]) => [key, tryAt(value.position, declaration, ModuleAddress.root, () => read(value))] as const)
    );
    try {
      const given = conformed(declaration, schema, values);
      return { config: plainOf(given), sensitive: marksOf(schema, given) };
    } catch (error) {
      throw withPlace(error, writtenAt(error, block), declaration, ModuleAddress.root);
    }
  }

  /** With no provider block, nothing is set, which a provider that requires a value refuses. */
  private async unwritten(name: string): Promise<Configuration> {
    const problem = nameProblem(`provider "${name}"`, namesOf(await this.limit.run(() => this.registry.configSchema(name))), []);
    if (problem) throw new Error(`${problem.message}, but the configuration has no provider "${name}" block`);

    return { config: {}, sensitive: [] };
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
