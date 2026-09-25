/** Where something was written: the file it came from, and the line and column in it. */
export interface Position {
  file: string;
  line: number;
  column: number;
}

/** Where `text`, written from `position` on, ends: a line break starts the next line, anything else moves one column. */
export function advanced(position: Position, text: string): Position {
  let { line, column } = position;

  for (const char of text)
    if (char === '\n') {
      line++;
      column = 1;
    } else column++;

  return { file: position.file, line, column };
}
