import { ConfigError } from './ConfigError';
import { advanced, Position } from './Position';

/** A piece of a string's text: plain text, or what one `${ … }` holds and where that begins. */
export type Piece = { kind: 'text'; text: string } | { kind: 'interpolation'; text: string; position: Position };

/** Splits a string's text at each `${ … }`. `start` is where the text begins, so every piece knows where it was written. */
export function splitTemplate(raw: string, start: Position): Piece[] {
  const pieces: Piece[] = [];
  let cursor = 0;
  let position = start;

  while (cursor < raw.length) {
    const open = raw.indexOf('${', cursor);
    const text = raw.slice(cursor, open === -1 ? raw.length : open);
    if (text !== '') pieces.push({ kind: 'text', text });
    if (open === -1) break;

    position = advanced(position, text);
    const close = raw.indexOf('}', open);
    if (close === -1) throw new ConfigError("This '${' is never closed with '}'", position);

    const inner = raw.slice(open + 2, close);
    const innerStart = advanced(position, '${');
    pieces.push({ kind: 'interpolation', text: inner, position: innerStart });

    position = advanced(innerStart, `${inner}}`);
    cursor = close + 1;
  }

  return pieces;
}
