import { ConfigFiles } from '@clay/orchestrator';
import { ConfigError, Range } from '@clay/parser';

/** The line the error points at, with a caret under the column. Nothing if the file cannot be read any more. */
function sourceLine(range: Range, files: ConfigFiles): string[] {
  const line = files.read(range.file)?.split('\n')[range.line - 1];
  if (line === undefined) return [];

  const gutter = `  ${range.line}: `;

  return ['', gutter + line, ' '.repeat(gutter.length + range.column - 1) + '^'];
}

/** What went wrong, and where it was written: the file, the line, the block, and the line itself. */
export function describeError(error: unknown, files: ConfigFiles): string {
  if (!(error instanceof ConfigError)) return error instanceof Error ? error.message : String(error);

  const where = `  on ${error.range.file} line ${error.range.line}${error.context ? `, in ${error.context}` : ''}:`;

  const inModule = error.module ? ['', `  in ${error.module}`] : [];

  return [error.message, '', where, ...sourceLine(error.range, files), ...inModule].join('\n');
}
