import { isDeepStrictEqual } from 'node:util';

import { own } from './AttributePath';
import type { AttributePath } from './AttributePath';
import type { Schema } from './Schema';
import { UNKNOWN } from './unknown';

/** A create when `prior` is null, else a change. */
export interface PlanRequest {
  /** As the refresh read it. */
  prior: Record<string, unknown> | null;
  /** The configuration's values, plus computed values from `prior` the configuration does not set. */
  proposed: Record<string, unknown>;
  /** The configuration's values alone, to tell an optional computed value it sets from one kept from `prior`. */
  config: Record<string, unknown>;
}

export interface PlannedChange {
  /** UNKNOWN where only the apply knows a value. A value the configuration sets must stay as set. */
  after: Record<string, unknown>;
  /** Attributes whose change forces a replace. */
  replace: AttributePath[];
}

export interface CreateRequest {
  config: Record<string, unknown>;
  /** The provider's plan at apply; UNKNOWN where only the apply knows a value. */
  planned: Record<string, unknown>;
}

export interface UpdateRequest extends CreateRequest {
  /** As state holds it, so the provider can find it. */
  prior: Record<string, unknown>;
}

/**
 * A plan from the schema alone. With no change the resource stays as read. With a change, computed values the configuration does not set
 * become UNKNOWN unless `kept`, and a changed `forceNew` attribute replaces the resource.
 */
export function planFromSchema(schema: Schema, { prior, proposed, config }: PlanRequest): PlannedChange {
  if (prior !== null && isDeepStrictEqual(prior, proposed)) return { after: prior, replace: [] };

  const kept = (name: string) => schema[name].kept && Object.hasOwn(proposed, name);
  const remade = Object.keys(schema).filter((name) => schema[name].computed && !Object.hasOwn(config, name) && !kept(name));
  const after = Object.fromEntries([...Object.entries(proposed), ...remade.map((name) => [name, UNKNOWN])]);
  if (prior === null) return { after, replace: [] };

  const replacing = Object.keys(schema).filter((name) => schema[name].forceNew && !isDeepStrictEqual(own(prior, name), own(proposed, name)));
  return { after, replace: replacing.map((name) => [name]) };
}

/** Numbers in inputs arrive as `ExactNumber`, never rounded. */
export interface Provider {
  readonly resources: string[];

  /** A type may also be a resource type, as a file is both written and read. */
  readonly dataSources: string[];

  getSchema(type: string): Promise<Schema>;

  /** Throws on invalid inputs. An input may be UNKNOWN until apply, and is checked then. */
  validate(type: string, inputs: Record<string, unknown>): Promise<void>;

  /** `planFromSchema` is a default that plans from the schema alone. */
  plan(type: string, request: PlanRequest): Promise<PlannedChange>;

  /** The resource as it is now, or `null` when it no longer exists. */
  read(type: string, prior: Record<string, unknown>): Promise<Record<string, unknown> | null>;

  /** Separate from the resource schema, since one type may be both with different attributes. */
  getDataSourceSchema(type: string): Promise<Schema>;

  /** Throws on invalid inputs. An input may be UNKNOWN until the data source is read, and is checked again then. */
  validateDataSource(type: string, inputs: Record<string, unknown>): Promise<void>;

  readDataSource(type: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>>;

  /** Returns the whole resource, computed values included. */
  create(type: string, request: CreateRequest): Promise<Record<string, unknown>>;
  /** Returns the whole resource. */
  update(type: string, request: UpdateRequest): Promise<Record<string, unknown>>;
  delete(type: string, prior: Record<string, unknown>): Promise<void>;

  /** The real thing the values name; undefined until the values say. */
  identify?(type: string, values: Record<string, unknown>): Promise<Identity | undefined>;
}

/** The real thing an object is, as a file. */
export interface Identity {
  /** The same for every spelling of the thing, before it is made and after, and unique across kinds of thing, as `file /tmp/a.txt`. */
  key: string;
  /** How a message names it, as `the file /tmp/a.txt`. */
  name: string;
}

export interface ResourceHandler {
  getSchema(): Promise<Schema>;

  validate(inputs: Record<string, unknown>): Promise<void>;

  plan(request: PlanRequest): Promise<PlannedChange>;

  read(prior: Record<string, unknown>): Promise<Record<string, unknown> | null>;

  /** Returns the whole resource, computed values included. */
  create(request: CreateRequest): Promise<Record<string, unknown>>;

  /** Returns the whole resource. */
  update(request: UpdateRequest): Promise<Record<string, unknown>>;

  delete(prior: Record<string, unknown>): Promise<void>;

  identify?(values: Record<string, unknown>): Promise<Identity | undefined>;
}

export interface DataSourceHandler {
  getSchema(): Promise<Schema>;

  validate(inputs: Record<string, unknown>): Promise<void>;

  read(inputs: Record<string, unknown>): Promise<Record<string, unknown>>;
}
