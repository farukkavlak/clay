import { Address } from '@clay/contracts';
import { scopeOf } from '../keys';
import { ScopeManager } from '../scope/ScopeManager';
import { IResolver } from './IResolver';
import { UnresolvedReferenceError } from './UnresolvedReferenceError';

export class ModuleOutputResolver implements IResolver {
  constructor(private scopeManager: ScopeManager) {}

  resolve(pathParts: string[], context: Address): unknown {
    if (pathParts.length < 3) throw new Error(`Module output reference must include output name: ${pathParts.join('.')}`);

    const [, moduleName, outputName] = pathParts;
    const currentScope = scopeOf(context);
    const childScope = currentScope ? `${currentScope}.module.${moduleName}` : `module.${moduleName}`;

    const output = this.scopeManager.getOutput(childScope, outputName);
    if (output === undefined) throw new UnresolvedReferenceError(`Output "${outputName}" not found in module "${childScope}"`);

    return output;
  }
}
