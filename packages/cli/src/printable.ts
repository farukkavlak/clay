// C0 but tab and line feed, DEL, C1, and the direction marks and controls that make a line show other than it is.
// eslint-disable-next-line no-control-regex -- matching control characters is what this is for.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** Each control character shows as one of its own, one cell wide, so text from outside Clay cannot drive the terminal. */
export function printable(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll(CONTROL, (control) => {
    const code = control.codePointAt(0)!;
    if (code < 0x20) return String.fromCodePoint(0x24_00 + code);
    return code === 0x7f ? '\u2421' : '\uFFFD';
  });
}

/** What an error says, printable. */
export function messageOf(error: unknown): string {
  return printable(error instanceof Error ? error.message : String(error));
}
