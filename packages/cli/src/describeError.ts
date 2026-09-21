import { ConfigFiles } from '@clay/orchestrator';
import { ConfigError, Position } from '@clay/parser';

/** The line the error points at, with a caret under the column. Nothing if the file cannot be read any more. */
function sourceLine(position: Position, files: ConfigFiles): string | undefined {
  const line = files.read(position.file)?.split('\n')[position.line - 1];
  if (line === undefined) return undefined;

  const gutter = `  ${position.line}: `;

  return `${gutter}${line}\n${' '.repeat(gutter.length + position.column - 1)}^`;
}

/** What went wrong, then where: the file and line, the block, the line itself, and the module it ran in. */
export function describeError(error: unknown, files: ConfigFiles): string {
  if (!(error instanceof ConfigError)) return error instanceof Error ? error.message : String(error);

  const inBlock = error.block ? `, in ${error.block}` : '';
  const where = `  on ${error.position.file} line ${error.position.line}${inBlock}:`;
  const inModule = error.module ? `  in ${error.module}` : undefined;

  return [error.message, where, sourceLine(error.position, files), inModule].filter((paragraph) => paragraph !== undefined).join('\n\n');
}
