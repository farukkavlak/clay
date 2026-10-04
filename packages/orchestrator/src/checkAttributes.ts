import { Schema } from '@clay/contracts';
import { ConfigError, DataBlock, Position, ResourceBlock, spell } from '@clay/parser';

import { nameProblem, namesOf } from './conformValues';
import { LoadedResource } from './components/ModuleLoader';
import { Context } from './keys';
import { withPlace } from './place';

type Block = ResourceBlock | DataBlock;

const typeOf = (block: Block): string => (block.type === 'Resource' ? block.resourceType : block.dataSourceType);

/** A value only the provider makes would show in the plan as the configuration set it and then never be applied. A name set to `null` is left out, so it sets none. */
function computedSet(block: Block, schema: Schema): { message: string; position: Position } | undefined {
  for (const [name, value] of Object.entries(block.attributes)) {
    const { computed, optional } = schema[name];
    if (value.type !== 'Null' && computed && !optional) return { message: `${name} is computed by ${typeOf(block)} and cannot be set`, position: value.position };
  }

  return undefined;
}

/** A name written is placed where it is written; one left out, at the block. */
function problemIn(block: Block, schema: Schema): { message: string; position: Position } | undefined {
  const named = nameProblem(typeOf(block), namesOf(schema), Object.keys(block.attributes));
  if (named?.set !== undefined) return { message: named.message, position: block.attributes[named.set].position };

  return computedSet(block, schema) ?? (named && { message: named.message, position: block.position });
}

/** Each name a block sets, and each it leaves out, is checked against its schema before any value in it is resolved. */
export function checkNames(block: Block, schema: Schema, address: Context): void {
  const problem = problemIn(block, schema);
  if (problem) throw withPlace(new ConfigError(problem.message, problem.position), problem.position, spell(block), address);
}

/** Checked once per block, so a block with no instance is checked too. */
export function checkAttributes(loaded: LoadedResource[], schemas: Map<string, Schema>): void {
  for (const { block, address } of loaded) checkNames(block, schemas.get(block.resourceType) ?? {}, address);
}
