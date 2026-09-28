import { TemplatePart } from './ast';

const INDENT = /^[\t ]*/;

const BLANK = /^[\t ]*\r?\n$/;

function leading(text: string): number {
  return INDENT.exec(text)?.[0].length ?? 0;
}

/** The first piece starts a line, and so does each one after text that ends one. */
function startsLine(pieces: TemplatePart[], i: number): boolean {
  const before = pieces[i - 1];
  return i === 0 || (typeof before === 'string' && before.endsWith('\n'));
}

/** A line that opens with an interpolation has no indent; a blank line has no say. */
function indentOf(piece: TemplatePart): number | undefined {
  if (typeof piece !== 'string') return 0;

  return BLANK.test(piece) ? undefined : leading(piece);
}

/** A line with text loses the smallest indent of such lines, and a blank line keeps only its line break. */
function flushLine(piece: string, shared: number): string {
  return BLANK.test(piece) ? piece.slice(leading(piece)) : piece.slice(shared);
}

/** `<<-`: the smallest indent of the lines with text on them comes off every line. A tab counts as one character, as a space does. */
export function flushed(pieces: TemplatePart[]): TemplatePart[] {
  const starts = pieces.map((_, i) => startsLine(pieces, i));
  const indents = pieces.flatMap((piece, i) => (starts[i] ? [indentOf(piece)] : [])).filter((indent) => indent !== undefined);
  const shared = indents.reduce((least, indent) => Math.min(least, indent), Infinity);

  return pieces.map((piece, i) => (starts[i] && typeof piece === 'string' ? flushLine(piece, shared) : piece));
}
