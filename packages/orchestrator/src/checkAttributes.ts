import { Schema } from '@clay/contracts';
import { ConfigError, Position, ResourceBlock, spell } from '@clay/parser';

import { nameProblem } from './checkValues';
import { LoadedResource } from './components/ModuleLoader';
import { withPlace } from './place';

/** A value only the provider makes would show in the plan as the configuration set it and then never be applied. */
function computedSet(block: ResourceBlock, schema: Schema): { message: string; position: Position } | undefined {
  for (const [name, value] of Object.entries(block.attributes)) {
    const definition = schema[name];
    if (definition.computed && !definition.optional) return { message: `${name} is computed by ${block.resourceType} and cannot be set`, position: value.position };
  }

  return undefined;
}

/** A name written is placed where it is written; one left out, at the block. */
function problemIn(block: ResourceBlock, schema: Schema): { message: string; position: Position } | undefined {
  const named = nameProblem(block.resourceType, schema, Object.keys(block.attributes));
  if (named?.set !== undefined) return { message: named.message, position: block.attributes[named.set].position };

  return computedSet(block, schema) ?? (named && { message: named.message, position: block.position });
}

/** Each name a resource block sets, and each it leaves out, is checked against its schema once, before any value is resolved, so a block with no instance is checked too. */
export function checkAttributes(loaded: LoadedResource[], schemas: Map<string, Schema>): void {
  for (const { block, address } of loaded) {
    const problem = problemIn(block, schemas.get(block.resourceType) ?? {});
    if (problem) throw withPlace(new ConfigError(problem.message, problem.position), problem.position, spell(block), address);
  }
}
