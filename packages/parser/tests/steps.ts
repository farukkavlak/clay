import { Step } from '../src/reference';

/** A string is a step after a dot, a number an index; a string key in brackets is passed as { key }. */
export const steps = (...parts: (string | number | Step)[]): Step[] =>
  parts.map((part) => (typeof part === 'object' ? part : typeof part === 'number' ? { key: part } : { name: part }));
