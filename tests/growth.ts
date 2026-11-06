/** Work that grows with its size takes about 4 times as long at four times the size, and 16 where each part is held against every other. */
export const LINEAR = 8;

/** Collects what the last measure left, so the next does not pay for it. */
function collector(): () => void {
  const { gc } = globalThis;
  if (gc === undefined) throw new Error('growth needs node --expose-gc, which the timing config gives');

  return () => void gc();
}

/** How many times longer `measure` takes at four times `size`; each size keeps its fastest of `rounds` in turn, so a pause or a cold first run decides nothing. */
export async function growth(size: number, measure: (size: number) => number | Promise<number>, rounds = 5): Promise<number> {
  const collect = collector();
  const small: number[] = [];
  const large: number[] = [];
  for (let round = 0; round < rounds; round++) {
    collect();
    small.push(await measure(size));
    collect();
    large.push(await measure(size * 4));
  }

  return Math.min(...large) / Math.min(...small);
}
