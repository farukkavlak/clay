export interface Position {
  file: string;
  line: number;
  column: number;
}

/** The position after `text`. */
export function advanced(position: Position, text: string): Position {
  let { line, column } = position;

  for (const char of text)
    if (char === '\n') {
      line++;
      column = 1;
    } else column++;

  return { file: position.file, line, column };
}
