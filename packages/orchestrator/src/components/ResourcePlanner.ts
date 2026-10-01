import { AttributePath, containsUnknown, own, PlannedChange, PlanRequest, Provider, Resource, Schema, valueAt } from '@clay/contracts';
import { isDeepStrictEqual } from 'node:util';

import { conformValues } from '../conformValues';
import { ProviderRegistry } from '../ProviderRegistry';
import { shown } from '../shown';

/** A resource as its provider plans it, whether the change replaces it, and the configuration as the schema takes it, which is what the provider is sent. */
export interface ResourcePlan {
  after: Record<string, unknown>;
  replace: boolean;
  config: Record<string, unknown>;
}

/** What the configuration asks for, with what the provider computed kept as the refresh read it, since the configuration never sets that. */
function proposed(prior: Record<string, unknown>, config: Record<string, unknown>, schema: Schema): Record<string, unknown> {
  const kept = Object.entries(prior).filter(([name]) => Object.hasOwn(schema, name) && schema[name].computed && !Object.hasOwn(config, name));

  return { ...config, ...Object.fromEntries(kept) };
}

/** A place the provider says would replace the resource replaces it only where the value there changes. */
function replaces(paths: AttributePath[], prior: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return paths.some((path) => !isDeepStrictEqual(valueAt(prior, path), valueAt(after, path)));
}

/** A provider makes only what the configuration leaves to it: a value the configuration sets stays as set, and one it does not set is one the provider computes. */
function checkPlanned(type: string, schema: Schema, config: Record<string, unknown>, after: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(config)) {
    const got = own(after, name);
    if (!isDeepStrictEqual(got, value)) throw new Error(`${type} planned ${name} = ${shown(got)}, but the configuration sets ${shown(value)}`);
  }

  for (const name of Object.keys(after))
    if (!Object.hasOwn(config, name) && !(Object.hasOwn(schema, name) && schema[name].computed))
      throw new Error(`${type} planned ${name}, which the configuration does not set and ${type} does not compute`);
}

/** A kept value stays as it was made until the resource is replaced, so a change in place has it already. */
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

/** Asks a resource's provider what it will hold once applied, and holds the answer to what the configuration sets. */
export class ResourcePlanner {
  constructor(private providers: ProviderRegistry) {}

  /** The values are checked first, since a plan of values the provider would refuse means nothing. A value not known yet is checked again once the apply knows it. */
  async plan(type: string, schema: Schema, current: Resource | undefined, written: Record<string, unknown>): Promise<ResourcePlan> {
    const provider = this.providers.get(type);
    const config = conformValues(type, schema, written);
    await provider.validate(type, config);
    if (!current) return this.create(provider, type, schema, config);

    const change = await this.ask(provider, type, schema, { prior: current.attributes, proposed: proposed(current.attributes, config, schema), config });
    if (!replaces(change.replace, current.attributes, change.after)) {
      checkKept(type, schema, current.attributes, change.after);
      return { after: change.after, replace: false, config };
    }

    // What the old resource holds goes with it, so the new one is planned as if made from nothing.
    return { ...(await this.create(provider, type, schema, config)), replace: true };
  }

  private async create(provider: Provider, type: string, schema: Schema, config: Record<string, unknown>): Promise<ResourcePlan> {
    const { after } = await this.ask(provider, type, schema, { prior: null, proposed: config, config });

    return { after, replace: false, config };
  }

  private async ask(provider: Provider, type: string, schema: Schema, request: PlanRequest): Promise<PlannedChange> {
    const change = await provider.plan(type, request);
    checkPlanned(type, schema, request.config, change.after);

    return change;
  }
}
