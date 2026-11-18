import { BackendBlock } from '@clay/parser';

import { StateBackend } from '../StateBackend';
import { build, defaultLocal } from './build';
import { blockSettings, Environment } from './settings';

/** With no block, the state is the file Clay has always kept next to the configuration. */
export function backendFrom(block: BackendBlock | undefined, workingDir: string, env: Environment): StateBackend {
  return block === undefined ? defaultLocal(workingDir) : build(blockSettings(block), workingDir, env);
}
