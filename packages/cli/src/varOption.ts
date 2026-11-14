import { VariableInput } from '@clay/planner';
import { InvalidArgumentError, Option } from 'commander';

/** The value may hold `=` too; only the first one ends the name. Each is kept, in the order given. */
function parseVar(pair: string, previous: VariableInput[] = []): VariableInput[] {
  const equals = pair.indexOf('=');
  if (equals <= 0) throw new InvalidArgumentError('it takes name=value');

  return [...previous, { name: pair.slice(0, equals), text: pair.slice(equals + 1) }];
}

export function varOption(): Option {
  return new Option('--var <name=value>', 'Give a root variable a value; a later one for the same name wins').argParser(parseVar);
}
