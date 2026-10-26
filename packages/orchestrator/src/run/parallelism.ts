/** How many actions of a layer run at once, unless the caller says. */
export const DEFAULT_PARALLELISM = 10;

export interface Pace {
  parallelism: number;
  signal?: AbortSignal;
}

/** 0, a fraction or NaN would stall or break the run, so they are refused where they come in. */
export function checkParallelism(parallelism: number): void {
  if (!Number.isInteger(parallelism) || parallelism < 1) throw new Error(`parallelism is a whole number from 1, not ${parallelism}`);
}
