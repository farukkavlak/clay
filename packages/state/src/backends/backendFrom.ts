import { BackendBlock } from '@clay/parser';

import { StateBackend } from '../StateBackend';
import { build } from './build';
import { LocalBackend } from './LocalBackend';
import { blockSettings } from './settings';

/** With no block, the state is the file Clay has always kept next to the configuration. */
export function backendFrom(block: BackendBlock | undefined, workingDir: string): StateBackend {
  return block === undefined ? new LocalBackend(workingDir) : build(blockSettings(block), workingDir);
}
