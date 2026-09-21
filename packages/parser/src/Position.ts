/** Where something was written: the file it came from, and the line and column in it. */
export interface Position {
  file: string;
  line: number;
  column: number;
}
