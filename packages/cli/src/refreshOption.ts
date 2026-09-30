import { InvalidArgumentError, Option } from 'commander';

function parseRefresh(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;

  throw new InvalidArgumentError('--refresh is true or false');
}

/** `--refresh=false` plans against the state alone. Left out, a plan reads each resource back first. */
export function refreshOption(): Option {
  return new Option('--refresh <bool>', 'Read each resource from its provider before planning (default: true)').argParser(parseRefresh);
}
