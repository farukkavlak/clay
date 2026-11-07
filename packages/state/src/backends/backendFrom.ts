import { BackendBlock } from '@clay/parser';

import { StateBackend } from '../StateBackend';
import { build } from './build';
import { LocalBackend } from './LocalBackend';
import { blockSettings, Environment } from './settings';

/** With no block, the state is the file Clay has always kept next to the configuration. */
export function backendFrom(block: BackendBlock | undefined, workingDir: string, env: Environment): StateBackend {
  return block === undefined ? new LocalBackend(workingDir) : build(blockSettings(block), workingDir, env);
}
