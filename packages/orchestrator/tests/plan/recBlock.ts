import { ResourceBlock } from '@clay/parser';

/** A `rec` block with nothing in it, for a graph built by hand. */
export function recBlock(name: string): ResourceBlock {
  return { type: 'Resource', resourceType: 'rec', name, attributes: {}, position: { file: 'main.clay', line: 1, column: 1 } };
}
