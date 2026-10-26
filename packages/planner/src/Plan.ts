import { Address, AttributePath, InstanceKey, ModuleStep, Output, Resource, Schema } from '@clay/contracts';

export type ActionType = 'CREATE' | 'UPDATE' | 'REPLACE' | 'DELETE' | 'NO_OP';

export interface DesiredResource {
  address: Address;
  attributes: Record<string, unknown>;
  /** As the provider plans it after apply; UNKNOWN where only the apply knows a value. */
  after: Record<string, unknown>;
  /** The steps to each sensitive part of the configuration it was given. */
  sensitive: AttributePath[];
  replace: boolean;
  dependencies: string[];
  /** The paths of the existing resource the configuration does not change; left out where it does not exist yet. */
  ignored?: AttributePath[];
  /** A destroy or a replace of it is refused. */
  preventDestroy?: true;
  /** Its block says so, or a block that reads it does: a replace makes the new object first. */
  createBeforeDestroy?: true;
  /** Its state address before count was added or removed; the state it was planned against already has the move. */
  movedFrom?: string;
}

/** An undefined `old` means added, an undefined `new` means removed. */
export type Changes = Record<string, { old: unknown; new: unknown }>;

export type OutputChanges = Record<string, { old: Output | undefined; new: Output | undefined }>;

export interface PlanAction {
  type: ActionType;
  resourceType: string;
  name: string;
  modulePath?: readonly ModuleStep[];
  key?: InstanceKey;
  /** Its state address before count was added or removed; the move runs before the action. */
  movedFrom?: string;
  /** Apply resolves the attributes again and checks each known value against these. */
  planned?: Record<string, unknown>;
  /** As the provider planned it after apply. */
  after?: Record<string, unknown>;
  /** The steps to each sensitive part of the resource as the plan leaves it, a no-op too. Left out where there is none. */
  sensitive?: AttributePath[];
  /** On a replace: the new object is made first, and the old one is destroyed once what reads it is updated. */
  createBeforeDestroy?: true;
  /** On a delete: it destroys the objects a replace left behind, not the current one. */
  deposed?: true;
  /** On a no-op: the values stay, which parts are sensitive changes. */
  marksChange?: true;
  /** On an update or a replace: the paths held as the state has them, which the apply holds the same. */
  ignored?: AttributePath[];
  /** What the block says, left out where it does not prevent a destroy. A delete is judged by the state's flag instead. */
  preventDestroy?: true;
  /** On a no-op: the values stay, whether the block prevents a destroy changes. */
  protectionChange?: true;
  changes?: Changes;
  dependencies?: string[];
}

export interface Plan {
  serial: number;
  actions: PlanAction[];
  outputs: OutputChanges;
  /** Resources as state held them before refresh. */
  prevRun: Record<string, Resource>;
  /** Resources after refresh, which the actions run against; one that no longer exists is left out. */
  prior: Record<string, Resource>;
  /** Lets a saved plan tell sets from lists without the provider. */
  schemas: Record<string, Schema>;
  /** What each data source read at plan gave, by address, so the apply reads none of them again. */
  dataSources: Record<string, Record<string, Output>>;
  /** The steps to each sensitive part of what a data source read at plan gave, by address. Left out where there is none. */
  dataSensitive?: Record<string, AttributePath[]>;
  /** Data sources the apply reads, after what they read has changed. */
  readAtApply: string[];
}

/** Bump on any change to the file's shape after a release, so an older plan file is refused instead of misread. */
export const PLAN_FILE_VERSION = '31.0';

export interface PlanFile extends Plan {
  version: string;
  timestamp: string;
  /** A saved plan applies this, not whatever is on disk later. */
  config: string;
  /** Keyed by path relative to the root configuration. */
  modules: Record<string, string>;
}
