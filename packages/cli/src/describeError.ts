import { ConfigFiles } from '@clay/orchestrator';
import { ConfigError, Position } from '@clay/parser';

/** Undefined if the file is unreadable now; the original error matters more than the source line. */
function currentContent(file: string, files: ConfigFiles): string | undefined {
  try {
    return files.read(file);
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code === 'string') return undefined;

    throw error;
  }
}

function sourceLine(position: Position, files: ConfigFiles): string | undefined {
  const line = currentContent(position.file, files)?.split(/\r?\n/)[position.line - 1];
  if (line === undefined) return undefined;

  const gutter = `  ${position.line}: `;

  return `${gutter}${line}\n${' '.repeat(gutter.length + position.column - 1)}^`;
}

export function describeError(error: unknown, files: ConfigFiles): string {
  if (!(error instanceof ConfigError)) return error instanceof Error ? error.message : String(error);

  const inBlock = error.block ? `, in ${error.block}` : '';
  const where = `  on ${error.position.file} line ${error.position.line}${inBlock}:`;
  const inModule = error.module ? `  in ${error.module}` : undefined;

  return [error.message, where, sourceLine(error.position, files), inModule].filter((paragraph) => paragraph !== undefined).join('\n\n');
}
