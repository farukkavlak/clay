import { Schema } from '@clay/contracts';
import { ConfigError, DataBlock, Position, ResourceBlock, spell } from '@clay/parser';

import { nameProblem, namesOf } from './conformValues';
import { LoadedResource } from './components/ModuleLoader';
import { Context } from './keys';
import { withPlace } from './place';

type Block = ResourceBlock | DataBlock;

const typeOf = (block: Block): string => (block.type === 'Resource' ? block.resourceType : block.dataSourceType);

/** A computed-only value set in the configuration would show in the plan and never be applied. A `null` sets nothing. */
function computedSet(block: Block, schema: Schema): { message: string; position: Position } | undefined {
  for (const [name, value] of Object.entries(block.attributes)) {
    const { computed, optional } = schema[name];
    if (value.type !== 'Null' && computed && !optional) return { message: `${name} is computed by ${typeOf(block)} and cannot be set`, position: value.position };
  }

  return undefined;
}

/** A wrong name is reported at its position, a missing one at the block. */
function problemIn(block: Block, schema: Schema): { message: string; position: Position } | undefined {
  const named = nameProblem(typeOf(block), namesOf(schema), Object.keys(block.attributes));
  if (named?.set !== undefined) return { message: named.message, position: block.attributes[named.set].position };

  return computedSet(block, schema) ?? (named && { message: named.message, position: block.position });
}

/** Runs before any value is resolved. */
export function checkNames(block: Block, schema: Schema, address: Context): void {
  const problem = problemIn(block, schema);
  if (problem) throw withPlace(new ConfigError(problem.message, problem.position), problem.position, spell(block), address);
}

/** Once per block, so a block with no instance is checked too. */
export function checkAttributes(loaded: LoadedResource[], schemas: Map<string, Schema>): void {
  for (const { block, address } of loaded) checkNames(block, schemas.get(block.resourceType) ?? {}, address);
}
