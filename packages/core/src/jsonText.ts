// What JSON.stringify leaves raw: DEL, C1, and the direction marks and controls that make a line show other than it is.
const CONTROL = /[\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** A JSON value as JSON text with every control character escaped, so it reads back as the same value and cannot drive a terminal. */
export function jsonText(value: unknown, indent?: number): string {
  return JSON.stringify(value, undefined, indent).replaceAll(CONTROL, (control) => `\\u${control.codePointAt(0)!.toString(16).padStart(4, '0')}`);
}
