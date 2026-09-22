import { ConfigError } from './ConfigError';
import { Position } from './Position';

export interface VariableReference {
  kind: 'variable';
  name: string;
}

export interface DataReference {
  kind: 'data';
  type: string;
  name: string;
  attribute: string;
}

/** A module is read through its outputs, so nothing lies beyond the output name. */
export interface ModuleOutputReference {
  kind: 'module';
  module: string;
  output: string;
}

export interface ResourceReference {
  kind: 'resource';
  type: string;
  name: string;
  attribute: string;
}

/** A reference as the language reads it: what it names, and the one attribute it reads on that target. */
export type ParsedReference = VariableReference | DataReference | ModuleOutputReference | ResourceReference;

/** Without a position the engine adds one where the value was read. */
function refuse(message: string, position?: Position): never {
  throw position ? new ConfigError(message, position) : new Error(message);
}

function variableReference(parts: string[], spelled: string, position?: Position): VariableReference {
  if (parts.length < 2) refuse(`Variable reference must include a name: ${spelled}`, position);
  if (parts.length > 2) refuse(`Reference "${spelled}" reads deeper than the variable "${parts[1]}"`, position);

  return { kind: 'variable', name: parts[1] };
}

function dataReference(parts: string[], spelled: string, position?: Position): DataReference {
  if (parts.length < 4) refuse(`Data source reference must include attribute: ${spelled}`, position);
  if (parts.length > 4) refuse(`Reference "${spelled}" reads deeper than the attribute "${parts[3]}"`, position);

  return { kind: 'data', type: parts[1], name: parts[2], attribute: parts[3] };
}

function moduleOutputReference(parts: string[], spelled: string, position?: Position): ModuleOutputReference {
  if (parts.length < 3) refuse(`Module output reference must include output name: ${spelled}`, position);
  if (parts.length > 3) refuse(`Reference "${spelled}" reaches into a module; modules are read through their outputs`, position);

  return { kind: 'module', module: parts[1], output: parts[2] };
}

function resourceReference(parts: string[], spelled: string, position?: Position): ResourceReference {
  if (parts.length < 3) refuse(`Resource reference must include attribute: ${spelled}`, position);
  if (parts.length > 3) refuse(`Reference "${spelled}" reads deeper than the attribute "${parts[2]}"`, position);

  return { kind: 'resource', type: parts[0], name: parts[1], attribute: parts[2] };
}

/** The one place that says what a reference's parts mean. A part beyond the one its kind reads is refused, not dropped. */
export function parseReference(parts: string[], position?: Position): ParsedReference {
  const spelled = parts.join('.');

  if (parts.includes('')) refuse(`Reference "${spelled}" has a part that is empty`, position);

  if (parts[0] === 'var') return variableReference(parts, spelled, position);
  if (parts[0] === 'data') return dataReference(parts, spelled, position);
  if (parts[0] === 'module') return moduleOutputReference(parts, spelled, position);

  return resourceReference(parts, spelled, position);
}
