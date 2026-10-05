import { AttributePath, containsUnknown, own, PlannedChange, PlanRequest, Provider, Resource, Schema, valueAt } from '@clay/contracts';
import { isDeepStrictEqual } from 'node:util';

import { conformValues } from '../conformValues';
import { heldBy } from '../providerResult';
import { ProviderRegistry } from '../ProviderRegistry';
import { shown } from '../shown';
import { plainOf, Value } from '../Value';

/** `config` is converted to the schema, as the provider receives it. */
export interface ResourcePlan {
  after: Record<string, unknown>;
  replace: boolean;
  config: Record<string, unknown>;
}

/** The configuration plus computed values from the refresh that the configuration does not set. */
function proposed(prior: Record<string, unknown>, config: Record<string, unknown>, schema: Schema): Record<string, unknown> {
  const kept = Object.entries(prior).filter(([name]) => Object.hasOwn(schema, name) && schema[name].computed && !Object.hasOwn(config, name));

  return { ...config, ...Object.fromEntries(kept) };
}

/** Only replaces where the value at the path actually changes. */
function replaces(paths: AttributePath[], prior: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return paths.some((path) => !isDeepStrictEqual(valueAt(prior, path), valueAt(after, path)));
}

/** The provider may not change a value the configuration sets. */
function checkPlanned(type: string, schema: Schema, config: Record<string, unknown>, after: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(config)) {
    const got = own(after, name);
    if (!isDeepStrictEqual(got, value)) throw new Error(`${type} planned ${name} = ${shown(got)}, but the configuration sets ${shown(value)}`);
  }

  for (const name of Object.keys(after))
    if (!Object.hasOwn(config, name) && !(Object.hasOwn(schema, name) && schema[name].computed))
      throw new Error(`${type} planned ${name}, which the configuration does not set and ${type} does not compute`);
}

/** An update may not plan a `kept` value as unknown: it is fixed from create until replace. */
function checkKept(type: string, schema: Schema, prior: Record<string, unknown>, after: Record<string, unknown>): void {
  for (const name of Object.keys(schema)) {
    if (!schema[name].kept || !containsUnknown(own(after, name))) continue;

    if (!Object.hasOwn(prior, name))
      throw new Error(
        `the state holds no ${name}, which ${type} keeps until the resource is replaced. Restore the state from its backup, or remove the resource with clay state rm`
      );
    throw new Error(`${type} planned ${name} as known after apply on a change in place, though it keeps it until it is replaced, which is a bug in the provider`);
  }
}

export class ResourcePlanner {
  constructor(private providers: ProviderRegistry) {}

  /** Validates first, since planning invalid values means nothing. Unknown values are validated again at apply. */
  async plan(type: string, schema: Schema, current: Resource | undefined, written: Record<string, Value>): Promise<ResourcePlan> {
    const provider = this.providers.get(type);
    const config = conformValues(type, schema, written);
    await provider.validate(type, config);
    if (!current) return this.create(provider, type, schema, config);

    const change = await this.ask(provider, type, schema, { prior: current.attributes, proposed: proposed(current.attributes, config, schema), config });
    if (!replaces(change.replace, current.attributes, change.after)) {
      checkKept(type, schema, current.attributes, change.after);
      return { after: change.after, replace: false, config };
    }

    // The old resource's values go with it, so the new one is planned from nothing.
    return { ...(await this.create(provider, type, schema, config)), replace: true };
  }

  private async create(provider: Provider, type: string, schema: Schema, config: Record<string, unknown>): Promise<ResourcePlan> {
    const { after } = await this.ask(provider, type, schema, { prior: null, proposed: config, config });

    return { after, replace: false, config };
  }

  private async ask(provider: Provider, type: string, schema: Schema, request: PlanRequest): Promise<PlannedChange> {
    const change = await provider.plan(type, request);
    const after = plainOf(heldBy(type, 'planned', schema, change.after));
    checkPlanned(type, schema, request.config, after);

    return { ...change, after };
  }
}
