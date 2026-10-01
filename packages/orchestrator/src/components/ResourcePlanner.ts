import { AttributePath, containsUnknown, isRecord, PlannedChange, PlanRequest, Provider, Resource, Schema } from '@clay/contracts';
import { isDeepStrictEqual } from 'node:util';

import { ProviderRegistry } from '../ProviderRegistry';
import { shown } from '../shown';

/** A resource as its provider plans it, and whether the change replaces it. */
export interface ResourcePlan {
  after: Record<string, unknown>;
  /** Known before the apply: the id a resource changed in place keeps, or one the provider gives a resource to create. */
  id?: string;
  replace: boolean;
}

function own(values: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

/** What the configuration asks for, with what the provider computed kept as the refresh read it, since the configuration never sets that. */
function proposed(prior: Record<string, unknown>, config: Record<string, unknown>, schema: Schema): Record<string, unknown> {
  const kept = Object.entries(prior).filter(([name]) => Object.hasOwn(schema, name) && schema[name].computed && !Object.hasOwn(config, name));

  return { ...config, ...Object.fromEntries(kept) };
}

/** What the steps lead to, or undefined where the value holds nothing there. */
function valueAt(value: unknown, path: AttributePath): unknown {
  let at = value;

  for (const step of path)
    if (Array.isArray(at) && typeof step === 'number') at = at[step];
    else if (isRecord(at) && typeof step === 'string') at = own(at, step);
    else return undefined;

  return at;
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

/** Asks a resource's provider what it will hold once applied, and holds the answer to what the configuration sets. */
export class ResourcePlanner {
  constructor(private providers: ProviderRegistry) {}

  /** The provider checks the values first, since a plan of values it would refuse means nothing. A value not known yet is checked once the apply knows it. */
  async plan(type: string, schema: Schema, current: Resource | undefined, config: Record<string, unknown>): Promise<ResourcePlan> {
    const provider = this.providers.get(type);
    if (!Object.values(config).some((value) => containsUnknown(value))) await provider.validate(type, config);
    if (!current) return this.create(provider, type, schema, config);

    const change = await this.ask(provider, type, schema, { id: current.id, prior: current.attributes, proposed: proposed(current.attributes, config, schema), config });
    if (!replaces(change.replace, current.attributes, change.after)) {
      if (change.id !== undefined && change.id !== current.id) throw new Error(`${type} planned the id ${shown(change.id)} for a resource it changes in place`);

      return { after: change.after, ...(current.id !== undefined && { id: current.id }), replace: false };
    }

    // What the old resource holds goes with it, so the new one is planned as if made from nothing.
    return { ...(await this.create(provider, type, schema, config)), replace: true };
  }

  private async create(provider: Provider, type: string, schema: Schema, config: Record<string, unknown>): Promise<ResourcePlan> {
    const { after, id } = await this.ask(provider, type, schema, { prior: null, proposed: config, config });

    return { after, ...(id !== undefined && { id }), replace: false };
  }

  private async ask(provider: Provider, type: string, schema: Schema, request: PlanRequest): Promise<PlannedChange> {
    const change = await provider.plan(type, request);
    checkPlanned(type, schema, request.config, change.after);

    return change;
  }
}
