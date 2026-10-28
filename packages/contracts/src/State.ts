import type { InstanceKey, ModuleStep } from './Address';
import type { AttributePath } from './AttributePath';
import { isRecord } from './isRecord';
import { isType } from './Type';
import type { Type } from './Type';

/** A provisioner run before its object is destroyed, with what it is given as the last apply resolved it. */
export interface DestroyProvisioner {
  type: string;
  config: Record<string, unknown>;
  /** The steps to each sensitive part of `config`, left out where there is none. */
  sensitive?: AttributePath[];
  /** Where set, a failure lets the destroy go on. */
  onFailure?: 'continue';
}

/** Whatever the provider finds it by, such as an id, is one of its attributes. */
export interface Resource {
  resourceType: string;
  name: string;
  modulePath?: readonly ModuleStep[];
  key?: InstanceKey;
  attributes: Record<string, unknown>;
  /** The steps to each sensitive part of `attributes`, left out where there is none. The values themselves are held as they are. */
  sensitive?: AttributePath[];
  /** The block's flag at the last apply, so a delete is judged by it once the block is gone. */
  preventDestroy?: true;
  /** Made, but a step after its create failed, so the next plan replaces it. */
  tainted?: true;
  /** Resolved at the last apply, so they run before a destroy once the block is gone too. */
  destroyProvisioners?: DestroyProvisioner[];
  /** The blocks it read, as `covers` reads them, kept so it can be deleted before their objects once the config drops it. */
  dependencies?: string[];
}

/** Carries its type, which no schema names, so a reader can tell a set from a list. */
export interface Output {
  value: unknown;
  type: Type;
  /** Kept beside the value, so what prints a state or a plan hides it without the configuration. */
  sensitive?: true;
}

export function isOutput(output: unknown): output is Output {
  return isRecord(output) && Object.hasOwn(output, 'value') && isType(output.type) && (output.sensitive === undefined || output.sensitive === true);
}

/** An earlier object of a resource that a replace has left behind, held until its provider destroys it. */
export interface DeposedObject {
  attributes: Record<string, unknown>;
  /** The steps to each sensitive part of `attributes`, left out where there is none. */
  sensitive?: AttributePath[];
  /** Kept so it can be destroyed before what it depended on. */
  dependencies?: string[];
}

export interface State {
  version: number;
  /** Bumped on each write. A saved plan records it, so a state written after the plan is caught. */
  serial: number;
  /** Root outputs from the last run. */
  outputs?: Record<string, Output>;
  resources: Record<string, Resource>;
  /** By the address of the resource they were left by, oldest first. Apart from `resources`: they outlive the current object, and a resource the provider no longer finds still leaves them. Left out where there are none. */
  deposed?: Record<string, DeposedObject[]>;
}

/** Bump on any change to the shape after a release. A higher version was written by a newer Clay and is refused. */
export const STATE_VERSION = 10;

export function emptyState(): State {
  return { version: STATE_VERSION, serial: 0, resources: {} };
}
