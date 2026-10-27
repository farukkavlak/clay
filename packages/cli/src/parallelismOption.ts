import { DEFAULT_PARALLELISM } from '@clay/orchestrator';
import { InvalidArgumentError, Option } from 'commander';

function parseParallelism(value: string): number {
  if (/^[1-9]\d*$/.test(value)) return Number(value);

  throw new InvalidArgumentError('--parallelism is a whole number from 1');
}

export function parallelismOption(): Option {
  return new Option('--parallelism <n>', `How many actions or provider calls run at once (default: ${DEFAULT_PARALLELISM})`).argParser(parseParallelism);
}
