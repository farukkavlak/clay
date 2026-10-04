import { ConfigError } from './ConfigError';
import { Position } from './Position';

/** A part of a reference: a name or key, from `.name` or `["key"]`, or an index into a list, from `[0]`. */
export type Step = string | number;

export interface VariableReference {
  kind: 'variable';
  name: string;
  path: Step[];
}

export interface DataReference {
  kind: 'data';
  type: string;
  name: string;
  attribute: string;
  path: Step[];
}

/** A module is read through its outputs. Whether the first step is an instance index or the output depends on the module call, which the engine reads. */
export interface ModuleOutputReference {
  kind: 'module';
  module: string;
  path: Step[];
}

/** Whether the first step is an instance key or an attribute depends on the block, which the engine reads. */
export interface ResourceReference {
  kind: 'resource';
  type: string;
  name: string;
  path: Step[];
}

/** `count.index`, the index of the instance being made. */
export interface CountReference {
  kind: 'count';
  path: Step[];
}

/** `each.key` and `each.value`, the key of the instance being made and the value `for_each` gives it. */
export interface EachReference {
  kind: 'each';
  name: 'key' | 'value';
  path: Step[];
}

/** `path.module` and `path.root`, the directory of the module being read and of the root module. */
export interface PathReference {
  kind: 'path';
  name: 'module' | 'root';
  path: Step[];
}

/** A reference as the language reads it: what it names, and the steps into the value it names. */
export type ParsedReference = VariableReference | DataReference | ModuleOutputReference | ResourceReference | CountReference | EachReference | PathReference;

/** What a reference can spell after a dot, so a declared name can always be read back. */
export const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function spellStep(step: Step, first: boolean): string {
  if (typeof step === 'number') return `[${step}]`;
  if (!NAME.test(step)) return `[${JSON.stringify(step)}]`;

  return first ? step : `.${step}`;
}

/** A reference as it would be written: `var.names[0]`, `local_file.a.tags["a.b"]`. */
export function spellReference(parts: Step[]): string {
  return parts.map((part, i) => spellStep(part, i === 0)).join('');
}

/** Steps as they would be written after what they read into: `.tags["a.b"][0]`. */
export function spellSteps(steps: Step[]): string {
  return steps.map((step) => spellStep(step, false)).join('');
}

/** Without a position the engine adds one where the value was read. */
function refuse(message: string, position?: Position): never {
  throw position ? new ConfigError(message, position) : new Error(message);
}

/** The parts that name the target have to be names, since scope keys join them with dots; the rest is the path into its value. */
function split(parts: Step[], count: number, position?: Position): { names: string[]; path: Step[] } {
  const names = parts.slice(0, count);
  const spelled = () => spellReference(parts);

  for (const part of names) {
    if (typeof part === 'number') refuse(`Reference "${spelled()}" has an index where it needs a name`, position);
    if (!NAME.test(part)) refuse(`Reference "${spelled()}" has ${JSON.stringify(part)} where it needs a name`, position);
  }

  return { names: names as string[], path: parts.slice(count) };
}

function variableReference(parts: Step[], position?: Position): VariableReference {
  if (parts.length < 2) refuse(`Variable reference must include a name: ${spellReference(parts)}`, position);
  const { names, path } = split(parts, 2, position);

  return { kind: 'variable', name: names[1], path };
}

function dataReference(parts: Step[], position?: Position): DataReference {
  if (parts.length < 4) refuse(`Data source reference must include attribute: ${spellReference(parts)}`, position);
  const { names, path } = split(parts, 4, position);

  return { kind: 'data', type: names[1], name: names[2], attribute: names[3], path };
}

function moduleOutputReference(parts: Step[], position?: Position): ModuleOutputReference {
  if (parts.length < 3) refuse(`Module output reference must include output name: ${spellReference(parts)}`, position);
  const { names, path } = split(parts, 2, position);

  return { kind: 'module', module: names[1], path };
}

function resourceReference(parts: Step[], position?: Position): ResourceReference {
  if (parts.length < 3) refuse(`Resource reference must include attribute: ${spellReference(parts)}`, position);
  const { names, path } = split(parts, 2, position);

  return { kind: 'resource', type: names[0], name: names[1], path };
}

function countReference(parts: Step[], position?: Position): CountReference {
  const { names, path } = split(parts, 2, position);
  if (names[1] !== 'index') refuse(`Reference "${spellReference(parts)}" names nothing: count.index is the index of an instance`, position);

  return { kind: 'count', path };
}

function eachReference(parts: Step[], position?: Position): EachReference {
  const { names, path } = split(parts, 2, position);
  const [, name] = names;
  if (name !== 'key' && name !== 'value') refuse(`Reference "${spellReference(parts)}" names nothing: each.key and each.value are the key and value of an instance`, position);

  return { kind: 'each', name, path };
}

function pathReference(parts: Step[], position?: Position): PathReference {
  const { names, path } = split(parts, 2, position);
  const [, name] = names;
  if (name !== 'module' && name !== 'root')
    refuse(`Reference "${spellReference(parts)}" names nothing: path.module and path.root are the directories of a module and of the root`, position);

  return { kind: 'path', name, path };
}

/** The one place that says what a reference's parts mean: which name its target, and which read into the target's value. */
export function parseReference(parts: Step[], position?: Position): ParsedReference {
  if (parts[0] === 'var') return variableReference(parts, position);
  if (parts[0] === 'data') return dataReference(parts, position);
  if (parts[0] === 'module') return moduleOutputReference(parts, position);
  if (parts[0] === 'count') return countReference(parts, position);
  if (parts[0] === 'each') return eachReference(parts, position);
  if (parts[0] === 'path') return pathReference(parts, position);

  return resourceReference(parts, position);
}
