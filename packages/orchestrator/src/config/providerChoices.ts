import { ConfigError, spell, spellProvider, Statement } from '@clay/parser';

/** The instances the provider blocks of a module configure. */
export function declaredInstances(program: Statement[]): Set<string> {
  return new Set(program.flatMap((stmt) => (stmt.type === 'Provider' ? [spellProvider(stmt.name, stmt.alias?.value)] : [])));
}

/** A block with no alias takes the default instance, which needs no provider block. */
export function checkProviderChoices(program: Statement[], declared: ReadonlySet<string>): void {
  for (const stmt of program) {
    if ((stmt.type !== 'Resource' && stmt.type !== 'Data') || stmt.provider?.alias === undefined) continue;

    const { name, alias, position } = stmt.provider;
    if (!declared.has(spellProvider(name, alias))) throw new ConfigError(`${spell(stmt)} names ${spellProvider(name, alias)}, which this module does not declare`, position);
  }
}
