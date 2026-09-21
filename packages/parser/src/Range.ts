/** Where something was written: the file it came from and the place in it. */
export interface Range {
  file: string;
  line: number;
  column: number;
}
