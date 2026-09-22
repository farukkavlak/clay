import { ConfigError } from './ConfigError';
import { Position } from './Position';

export interface VariableReference {
  kind: 'variable';
  name: string;
  path: string[];
}

export interface DataReference {
  kind: 'data';
  type: string;
  name: string;
  path: string[];
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
  path: string[];
}

/** A reference as the language reads it: what it names, and the path it reads on that target. */
export type ParsedReference = VariableReference | DataReference | ModuleOutputReference | ResourceReference;

/** The one place that says what a reference's parts mean. Without a position the engine adds one where the value was read. */
export function parseReference(parts: string[], position?: Position): ParsedReference {
  const spelled = parts.join('.');
  const refusal = (message: string): Error => (position ? new ConfigError(message, position) : new Error(message));

  if (parts[0] === 'var') {
    if (parts.length < 2) throw refusal(`Variable reference must include a name: ${spelled}`);

    return { kind: 'variable', name: parts[1], path: parts.slice(2) };
  }

  if (parts[0] === 'data') {
    if (parts.length < 4) throw refusal(`Data source reference must include attribute: ${spelled}`);

    return { kind: 'data', type: parts[1], name: parts[2], path: parts.slice(3) };
  }

  if (parts[0] === 'module') {
    if (parts.length < 3) throw refusal(`Module output reference must include output name: ${spelled}`);
    if (parts.length > 3) throw refusal(`Reference "${spelled}" reaches into a module; modules are read through their outputs`);

    return { kind: 'module', module: parts[1], output: parts[2] };
  }

  if (parts.length < 3) throw refusal(`Resource reference must include attribute: ${spelled}`);

  return { kind: 'resource', type: parts[0], name: parts[1], path: parts.slice(2) };
}
