import { AttributePath, containsUnknown, own, PlannedChange, PlanRequest, Provider, Resource, Schema, sensitiveUnder, touchesSensitive, valueAt } from '@clay/contracts';
import { isDeepStrictEqual } from 'node:util';

import { conformed } from '../values/conformValues';
import { keepPrior } from './ignoredChanges';
import { heldBy, hidingReason, undisclosed } from '../providers/providerResult';
import { Limit } from '../providers/Limit';
import { ProviderRegistry } from '../providers/ProviderRegistry';
import { shown } from '../shown';
import { marksOf } from '../values/schemaMarks';
import { plainOf, sensitiveAmong, Value, valueOf, withSensitive } from '../values/Value';

/** The resource as it is held now, and the paths of it the configuration does not change. */
export interface Ignoring {
  prior: Resource;
  paths: AttributePath[];
}

/** `config` is converted to the schema, as the provider receives it. `sensitive` holds the steps to each sensitive part of it. */
export interface ResourcePlan {
  after: Record<string, unknown>;
  replace: boolean;
  config: Record<string, unknown>;
  sensitive: AttributePath[];
}

/** Kept out of the configuration, so a message never says the configuration sets what it left out. */
function withDefaults(config: Record<string, unknown>, schema: Schema): Record<string, unknown> {
  const defaults = Object.entries(schema).filter(([name, { default: given }]) => given !== undefined && !Object.hasOwn(config, name));

  return { ...config, ...Object.fromEntries(defaults.map(([name, definition]) => [name, definition.default])) };
}

/** The configuration with its defaults, plus computed values from the refresh that the configuration does not set. */
function proposed(prior: Record<string, unknown>, config: Record<string, unknown>, schema: Schema): Record<string, unknown> {
  const kept = Object.entries(prior).filter(([name]) => Object.hasOwn(schema, name) && schema[name].computed && !Object.hasOwn(config, name));

  return { ...withDefaults(config, schema), ...Object.fromEntries(kept) };
}

/** Only replaces where the value at the path actually changes. */
function replaces(paths: AttributePath[], prior: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return paths.some((path) => !isDeepStrictEqual(valueAt(prior, path), valueAt(after, path)));
}

/** `against` names where the value came from: the configuration, or the default for one it left out. */
function plannedOtherwise(type: string, name: string, got: unknown, against: string, sensitive: readonly AttributePath[]): string {
  if (touchesSensitive(sensitive, [name])) return `${type} planned ${undisclosed([name])}`;

  return `${type} planned ${name} = ${shown(got)}, but ${against}`;
}

/** The provider may not change a value the configuration sets, or the default of one it leaves out. */
function checkPlanned(type: string, schema: Schema, config: Record<string, unknown>, after: Record<string, unknown>, sensitive: readonly AttributePath[]): void {
  const given = withDefaults(config, schema);
  for (const [name, value] of Object.entries(given)) {
    const got = own(after, name);
    if (isDeepStrictEqual(got, value)) continue;

    const against = Object.hasOwn(config, name) ? `the configuration sets ${shown(value)}` : `its default is ${shown(value)}`;
    throw new Error(plannedOtherwise(type, name, got, against, sensitive));
  }

  for (const name of Object.keys(after))
    if (!Object.hasOwn(given, name) && !(Object.hasOwn(schema, name) && schema[name].computed))
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

function valuesOf(schema: Schema, { config, sensitive }: { config: Record<string, unknown>; sensitive: AttributePath[] }): Record<string, Value> {
  return Object.fromEntries(Object.entries(config).map(([name, data]) => [name, withSensitive(valueOf(schema[name].type, data), sensitiveUnder(sensitive, name))]));
}

export class ResourcePlanner {
  constructor(
    private providers: ProviderRegistry,
    private limit: Limit
  ) {}

  /**
   * Validates first, since planning invalid values means nothing. Unknown values are validated again at apply.
   * An ignored path is as `ignoring.prior` held it before anything reads the configuration, so a change there plans nothing.
   */
  async plan(type: string, schema: Schema, current: Resource | undefined, written: Record<string, Value>, ignoring?: Ignoring): Promise<ResourcePlan> {
    const provider = this.providers.get(type);
    const given = conformed(type, schema, written);
    const kept = ignoring ? keepPrior(plainOf(given), sensitiveAmong(given), ignoring.prior, ignoring.paths) : { config: plainOf(given), sensitive: sensitiveAmong(given) };
    // After keepPrior, so an attribute made from an ignored one follows the mark it keeps.
    const { config } = kept;
    const sensitive = marksOf(schema, valuesOf(schema, kept));
    await hidingReason(type, sensitive, () => this.limit.run(() => provider.validate(type, config)));
    if (!current) return { ...(await this.create(provider, type, schema, config, sensitive)), sensitive };

    const request = { prior: current.attributes, proposed: proposed(current.attributes, config, schema), config };
    const change = await this.ask(provider, type, schema, request, sensitive, [...sensitive, ...(current.sensitive ?? [])]);
    if (!replaces(change.replace, current.attributes, change.after)) {
      checkKept(type, schema, current.attributes, change.after);
      return { after: change.after, replace: false, config, sensitive };
    }

    // The old resource's values go with it, so the new one is planned from nothing.
    return { ...(await this.create(provider, type, schema, config, sensitive)), replace: true, sensitive };
  }

  private async create(provider: Provider, type: string, schema: Schema, config: Record<string, unknown>, sensitive: AttributePath[]): Promise<Omit<ResourcePlan, 'sensitive'>> {
    const { after } = await this.ask(provider, type, schema, { prior: null, proposed: withDefaults(config, schema), config }, sensitive);

    return { after, replace: false, config };
  }

  /** `hidden` adds what the prior holds sensitive, which the provider is sent too. */
  private async ask(provider: Provider, type: string, schema: Schema, request: PlanRequest, sensitive: AttributePath[], hidden = sensitive): Promise<PlannedChange> {
    const change = await hidingReason(type, hidden, () => this.limit.run(() => provider.plan(type, request)));
    const after = plainOf(heldBy(type, 'planned', schema, change.after));
    checkPlanned(type, schema, request.config, after, sensitive);

    return { ...change, after };
  }
}
