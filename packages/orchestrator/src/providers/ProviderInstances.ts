import { AttributePath, Provider, Schema } from '@clay/provider';
import { ModuleAddress, Resource } from '@clay/core';
import { PlanAction } from '@clay/planner';
import { AttributeValue, ProviderBlock, spell, spellProvider } from '@clay/parser';

import { asError } from '../asError';
import { providerKey } from '../keys';
import { tryAt, withPlace } from '../place';
import { conformed, nameProblem, namesOf, writtenAt } from '../values/conformValues';
import { marksOf } from '../values/schemaMarks';
import { plainOf, Value } from '../values/Value';
import { hidingReason } from './providerResult';
import { Limit } from './Limit';
import { ProviderRegistry } from './ProviderRegistry';
import { SchemaTable } from './Schemas';

/** A provider block, and how a value it writes is read in the root module. */
export interface Written {
  block: ProviderBlock;
  read: (value: AttributeValue) => Value;
}

/**
 * A plan action or an object in state keeps the alias of its instance, which anything else must say. A block, which has a position, is
 * refused: the instance it takes depends on its module, and its graph node holds it.
 */
export type Handled = (Resource | PlanAction | { resourceType: string; alias: string | undefined }) & { position?: never };

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
    private readonly configSchemas: SchemaTable,
    private readonly limit: Limit
  ) {}

  async configure(name: string, written?: Written): Promise<void> {
    const { config, sensitive } = await this.check(name, written);
    const provider = this.registry.create(name);
    const alias = written?.block.alias?.value;
    const type = spellProvider(name, alias);
    try {
      await hidingReason(type, sensitive, () => this.limit.run(async () => provider.configure?.(config)), 'to configure');
    } catch (error) {
      // A hidden reason already names the provider.
      if (sensitive.length > 0) throw error;
      throw new Error(`${type}: ${asError(error).message}`, { cause: error });
    }

    this.configured.set(providerKey(name, alias), provider);
  }

  /** What the block sets, held to the provider's schema for it; a check goes no further, since a value may not be known yet. */
  async check(name: string, written?: Written): Promise<Configuration> {
    if (written === undefined) return this.unwritten(name);

    const { block, read } = written;
    const declaration = spell(block);
    const schema = this.configSchemas.get(name);
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

  get(of: Handled): Provider {
    return this.instance(this.registry.get(of.resourceType).name, of.alias);
  }

  /** Looked up apart from resources, since a type may be one and not the other. */
  reader(type: string, alias: string | undefined): Provider {
    return this.instance(this.registry.reader(type).name, alias);
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

  private instance(name: string, alias: string | undefined): Provider {
    const provider = this.configured.get(providerKey(name, alias));
    if (!provider) throw new Error(`${spellProvider(name, alias)} is asked before it is configured, which is a bug in Clay`);

    return provider;
  }
}
