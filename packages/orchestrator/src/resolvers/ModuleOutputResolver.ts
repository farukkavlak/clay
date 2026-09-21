import { Address } from '@clay/contracts';
import { childScope, scopeOf } from '../keys';
import { ScopeManager } from '../scope/ScopeManager';
import { IResolver } from './IResolver';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

export class ModuleOutputResolver implements IResolver {
  constructor(private scopeManager: ScopeManager) {}

  resolve(pathParts: string[], context: Address): unknown {
    if (pathParts.length < 3) throw new Error(`Module output reference must include output name: ${pathParts.join('.')}`);

    const [, moduleName, outputName] = pathParts;
    const scope = childScope(scopeOf(context), moduleName);

    const output = this.scopeManager.getOutput(scope, outputName);
    if (output === undefined) throw new UnresolvedReferenceError(`Output "${outputName}" not found in module "${scope}"`);

    return output;
  }
}
