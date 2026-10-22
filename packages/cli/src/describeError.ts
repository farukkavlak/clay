import { ConfigFiles } from '@clay/orchestrator';
import { ConfigError, Position } from '@clay/parser';

import { messageOf, printable } from './printable';

/** Undefined if the file is unreadable now; the original error matters more than the source line. */
function currentContent(file: string, files: ConfigFiles): string | undefined {
  try {
    return files.read(file);
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code === 'string') return undefined;

    throw error;
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// JS has no East_Asian_Width property, so these are the common wide ranges: a rarer wide character still counts one cell.
const WIDE = new RegExp(
  [
    String.raw`\p{Emoji_Presentation}|\uFE0F`,
    // Halfwidth kana and jamo are in these scripts but show in one cell.
    String.raw`(?![\uFF61-\uFFDC])(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})`,
    // CJK punctuation and fullwidth forms.
    String.raw`[\u3000-\u303F\uFF01-\uFF60\uFFE0-\uFFE6]`,
  ].join('|'),
  'u'
);

/**
 * As wide as `line` shows before `column`, keeping its tabs, since how wide a tab shows is up to the terminal.
 * A column counts code points, so one inside a character points at the whole character.
 */
function blankUnder(line: string, column: number): string {
  const end = [...line].slice(0, column - 1).join('').length;
  const before = [...graphemes.segment(line)].filter(({ index, segment }) => index + segment.length <= end);

  return before.map(({ segment }) => (segment === '\t' ? '\t' : WIDE.test(segment) ? '  ' : ' ')).join('');
}

function sourceLine(position: Position, files: ConfigFiles): string | undefined {
  const line = currentContent(position.file, files)?.split(/\r?\n/)[position.line - 1];
  if (line === undefined) return undefined;
  // One code point for one, so the column still holds, and graphemes are counted as they show.
  const shown = printable(line);

  const gutter = `  ${position.line}: `;

  return `${gutter}${shown}\n${' '.repeat(gutter.length)}${blankUnder(shown, position.column)}^`;
}

/** Printable, since the message, the line and the path come from outside Clay. */
export function describeError(error: unknown, files: ConfigFiles): string {
  if (!(error instanceof ConfigError)) return messageOf(error);

  const inBlock = error.block ? `, in ${error.block}` : '';
  const where = `  on ${error.position.file} line ${error.position.line}${inBlock}:`;
  const inModule = error.module ? `  in ${error.module}` : undefined;

  return printable([error.message, where, sourceLine(error.position, files), inModule].filter((paragraph) => paragraph !== undefined).join('\n\n'));
}
