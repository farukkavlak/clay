import { ModuleAddress } from '@clay/core';
import { ConfigError, DataBlock, ModuleBlock, ProviderChoice, ProviderPass, ResourceBlock, spell, spellProvider, Statement } from '@clay/parser';

import { withPlace } from '../place';
import { LoadedModule } from './ModuleLoader';

/** The name of the provider that handles a block's type. */
export type HandlerOf = (block: ResourceBlock | DataBlock) => string;

/** The instances the provider blocks of a module configure; only the root has any. */
function declaredInstances(program: Statement[]): Set<string> {
  return new Set(program.flatMap((stmt) => (stmt.type === 'Provider' ? [spellProvider(stmt.name, stmt.alias?.value)] : [])));
}

/** What is wrong with the instance a block chooses, if anything. */
function problemOf(block: ResourceBlock | DataBlock, { name, alias }: ProviderChoice, declared: ReadonlySet<string>, handlerOf: HandlerOf): string | undefined {
  const handler = handlerOf(block);
  const type = block.type === 'Resource' ? block.resourceType : block.dataSourceType;
  if (name !== handler) return `provider "${name}" does not handle "${type}"; provider "${handler}" does`;
  // A block with no alias takes the default instance, which needs no provider block.
  if (alias !== undefined && !declared.has(spellProvider(name, alias))) return `${spell(block)} names ${spellProvider(name, alias)}, which this module does not declare`;

  return undefined;
}

/** After the schemas, which refuse a type no provider has. A wrong choice is refused where it is written. */
export function checkProviderChoices(loadedModules: LoadedModule[], handlerOf: HandlerOf): void {
  for (const { address, program } of loadedModules) {
    const declared = declaredInstances(program);

    for (const stmt of program) {
      if ((stmt.type !== 'Resource' && stmt.type !== 'Data') || !stmt.provider) continue;

      const { position } = stmt.provider;
      const problem = problemOf(stmt, stmt.provider, declared, handlerOf);
      if (problem !== undefined) throw withPlace(new ConfigError(problem, position), position, spell(stmt), address);
    }
  }
}

/** What is wrong with what a call passes, if anything, and where: the caller gives only what it has. */
function passProblem({ name, to, position }: ProviderPass, declared: ReadonlySet<string>, isProvider: (name: string) => boolean): ConfigError | undefined {
  if (!isProvider(name)) return new ConfigError(`No provider is named "${name}"`, position);
  if (to.alias !== undefined && !declared.has(spellProvider(name, to.alias)))
    return new ConfigError(`providers passes ${spellProvider(name, to.alias)}, which this module does not declare`, to.position);

  return undefined;
}

/** Each call's `providers`, refused where it is written. */
export function checkProviderPasses(loadedModules: LoadedModule[], isProvider: (name: string) => boolean): void {
  for (const { address, program } of loadedModules) {
    const declared = declaredInstances(program);

    for (const stmt of program) {
      if (stmt.type !== 'Module') continue;

      for (const pass of stmt.providers ?? []) {
        const problem = passProblem(pass, declared, isProvider);
        if (problem !== undefined) throw withPlace(problem, problem.position, spell(stmt), address);
      }
    }
  }
}

/** The alias of the root instance a block in a module takes, left out for the default one. The provider is asked for only where a call passes one. */
export type RootAlias = (module: ModuleAddress, provider: () => string, alias: string | undefined) => string | undefined;

/** Through each call on the way up: a provider its call does not pass takes the caller's default one. */
export function rootAliases(loadedModules: LoadedModule[]): RootAlias {
  const calls = new Map<string, ModuleBlock>();
  for (const { address, program } of loadedModules) for (const stmt of program) if (stmt.type === 'Module') calls.set(address.child(stmt.name).toString(), stmt);

  const inRoot: RootAlias = (module, provider, alias) => {
    if (module.isRoot()) return alias;
    // A module has no provider block, so its blocks name no alias.
    if (alias !== undefined) throw new Error(`${module} names ${spellProvider(provider(), alias)}, which no call passes it, which is a bug`);

    const call = calls.get(module.toString());
    if (call === undefined) throw new Error(`no call makes ${module}, which is a bug`);

    const pass = call.providers?.find(({ name }) => name === provider());
    return inRoot(module.caller, provider, pass?.to.alias);
  };

  return inRoot;
}
