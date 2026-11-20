import { InvalidArgumentError, Option } from 'commander';

function parseRefresh(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;

  throw new InvalidArgumentError('--refresh is true or false');
}

export function refreshOption(): Option {
  return new Option('--refresh <bool>', 'Read each resource back from its provider while planning (default: true)').argParser(parseRefresh);
}
